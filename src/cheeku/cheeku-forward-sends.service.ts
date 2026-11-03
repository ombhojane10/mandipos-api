import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { config } from '../config';
import { Db } from '../db/db.service';
import { LIVE_BILLS } from '../admin/sql';
import { UdhaarAlertsService } from '../alerts/udhaar-alerts.service';
import { CheekuSlipSendsService, type CheekuImageSender } from './cheeku-slip-sends.service';
import { requireCheeku } from './cheeku';

const MAX_IMAGE_BYTES = 400_000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
/** Tried again this soon after a refusal, and given up on (shown as failed) after a day. */
const RETRY_MS = 5 * 60_000;
const GIVE_UP_MS = 24 * 3_600_000;
/** How long the bill link in the SMS keeps opening. */
const LINK_DAYS = 90;
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Where a slip's WhatsApp bill (or its SMS) stands, as the ledger says it. */
export type SendState = 'none' | 'notqueued' | 'onscan' | 'pending' | 'sent' | 'failed';

/** Sends one transactional SMS (to a 10-digit mobile) with the template's variables in order; swapped out in tests. */
export type CheekuSmsSender = (to: string, vars: string[]) => Promise<string>;

/** The cheeku slip template, else the grapes one: the bill goes as a grapes slip does. */
function slipTemplate(): string {
  const c = config();
  return c.CHEEKU_SLIP_TEMPLATE || c.SLIP_TEMPLATE;
}

/** A short random code for the SMS link (10 letters, ~59 bits: not guessable). */
function linkCode(): string {
  return Array.from(randomBytes(10), (b) => B62[b % 62]).join('');
}

/** A DLT variable: one line, at most 30 characters. */
function smsVar(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 30) || '-';
}

/**
 * The bill that goes to the grahak of a Cheeku slip — a slip sent on (Bikri laddan) or any ordinary slip:
 * the picture on WhatsApp, and an SMS with a link to the same picture.
 *
 * The terminal that made the slip uploads its picture with the grahak's mobile ({@link queue}); it goes only
 * when someone presses the button ({@link resend}), as a grapes slip does — a scan never sends it. Each channel keeps its own status: a refusal (WhatsApp off, a template still with
 * Meta or DLT, a bad moment) is kept and tried again every five minutes for a day — never dropped silently —
 * and every slip shows where its send stands, with a way to send it again ({@link resend}).
 */
@Injectable()
export class CheekuForwardSendsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('CheekuForwardSends');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Swappable in tests; the real one uploads the PNG and sends the slip template. */
  sender: CheekuImageSender = (to, template, params, png) => this.slips.sender(to, template, params, png);
  /** Swappable in tests; the real one is 2Factor's transactional SMS. */
  smsSender: CheekuSmsSender = (to, vars) => this.sendSms(to, vars);
  /** Whether the SMS half runs on a tick; tests switch it on without real credentials. */
  smsReady: () => boolean = () => this.smsOn();

  constructor(private readonly db: Db, private readonly alerts: UdhaarAlertsService, private readonly slips: CheekuSlipSendsService) {}

  /** The bot can send, and the shop's slip template is set. */
  on(): boolean {
    return this.alerts.canSend() && !!slipTemplate();
  }

  /** 2Factor's key, the DLT sender header and the SMS template are all set. */
  smsOn(): boolean {
    const c = config();
    return !!c.TWOFACTOR_API_KEY && !!c.CHEEKU_SMS_SENDER && !!c.CHEEKU_SMS_TEMPLATE;
  }

  onApplicationBootstrap() {
    if (!this.on() && !this.smsOn()) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.warn(`tick: ${(e as Error).message}`)), 20_000);
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /**
   * Keeps the picture and the number of a slip; sends nothing yet. `ladanOnly`: the Bikri laddan route, which
   * takes only a slip sent on. A slip already sent is left as it is.
   */
  async queue(shopId: string, billId: string, phone: string, imageBase64: string, params: string[], ladanOnly = true) {
    await requireCheeku(this.db, shopId);
    const png = Buffer.from(imageBase64, 'base64');
    if (png.length > MAX_IMAGE_BYTES) throw new BadRequestException('Photo bahut badi hai');
    if (!png.subarray(0, 4).equals(PNG)) throw new BadRequestException('Photo PNG nahi hai');
    await this.db.withShop(shopId, async (tx) => {
      const found = (await tx.query<{ ladan: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM lading_slips ls WHERE ls.bill_id = lb.id) AS ladan FROM ${LIVE_BILLS} lb WHERE lb.id = $1`, [billId])).rows[0];
      if (!found || (ladanOnly && !found.ladan)) throw new NotFoundException(ladanOnly ? 'Yeh parchi aage bheji hui nahi mili' : 'Yeh parchi nahi mili');
      await tx.query(
        `INSERT INTO forward_sends (shop_id, bill_id, phone, image, params, kind) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (shop_id, bill_id) DO UPDATE SET phone = EXCLUDED.phone, image = EXCLUDED.image, params = EXCLUDED.params
         WHERE forward_sends.status <> 'sent'`, [shopId, billId, phone, png, JSON.stringify(params), found.ladan ? 'ladan' : 'slip']);
      await tx.query(`INSERT INTO bill_links (code, shop_id, bill_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [linkCode(), shopId, billId]);
    });
    return { queued: true };
  }

  /** "Dobara bhejein": the WhatsApp and the SMS go again now, scanned or not. */
  async resend(shopId: string, billId: string) {
    await requireCheeku(this.db, shopId);
    await this.db.withShop(shopId, async (tx) => {
      const r = await tx.query(
        `UPDATE forward_sends SET status = 'waiting', force = true, tries = 0, error = NULL, retry_at = now() - interval '1 second', created_at = now(),
                sms_status = 'waiting', sms_force = true, sms_tries = 0, sms_error = NULL, sms_retry_at = now() - interval '1 second'
         WHERE bill_id = $1 AND EXISTS (SELECT 1 FROM ${LIVE_BILLS} lb WHERE lb.id = forward_sends.bill_id)`, [billId]);
      if (!r.rowCount) throw new NotFoundException('Is parchi ki image abhi nahi aayi — app se kholein');
    });
    // Do not make the person wait for the clock.
    if (this.on() || this.smsOn()) void this.tick().catch((e) => this.log.warn(`tick: ${(e as Error).message}`));
    return { queued: true };
  }

  /** The public bill page behind the SMS link: the slip's picture, or null when the code is unknown, old, or the slip was cancelled. */
  async linkImage(code: string): Promise<Buffer | null> {
    if (!/^[0-9A-Za-z]{10}$/.test(code)) return null;
    const [link] = await this.db.query<{ shop_id: string; bill_id: string }>(
      `SELECT shop_id, bill_id FROM bill_links WHERE code = $1 AND created_at > now() - interval '${LINK_DAYS} days'`, [code]);
    if (!link) return null;
    return this.db.withShop(link.shop_id, async (tx) => (await tx.query<{ image: Buffer }>(
      `SELECT fs.image FROM forward_sends fs JOIN ${LIVE_BILLS} lb ON lb.id = fs.bill_id WHERE fs.bill_id = $1`, [link.bill_id])).rows[0]?.image ?? null);
  }

  /**
   * One pass: every queued bill whose maal has been scanned (or was asked for) and is due is sent, on WhatsApp
   * and by SMS, each on its own. A row is taken (`sending`) before the send, so two passes never send one twice.
   */
  async tick(now = new Date()): Promise<{ sent: number; failed: number; waiting: number; sms: { sent: number; failed: number; waiting: number } }> {
    const out = { sent: 0, failed: 0, waiting: 0, sms: { sent: 0, failed: 0, waiting: 0 } };
    if (this.running) return out;
    this.running = true;
    try {
      const template = slipTemplate();
      const sms = this.smsReady();
      const shops = await this.db.query<{ id: string; name: string }>(`SELECT id, name FROM shops WHERE commodity = 'cheeku' AND approved_at IS NOT NULL`);
      for (const shop of shops) {
        const due = await this.db.withShop(shop.id, async (tx) => (await tx.query<{ bill_id: string; phone: string; image: Buffer; params: string[]; tries: number; created_at: Date }>(
          `UPDATE forward_sends SET status = 'sending' WHERE bill_id IN (
             SELECT fs.bill_id FROM forward_sends fs JOIN ${LIVE_BILLS} lb ON lb.id = fs.bill_id
             WHERE fs.status = 'waiting' AND fs.retry_at <= $1
               AND fs.force
             LIMIT 20 FOR UPDATE OF fs SKIP LOCKED)
           RETURNING bill_id, phone, image, params, tries, created_at`, [now])).rows);
        for (const d of due) {
          try {
            const wamid = await this.sender(`91${d.phone}`, template, d.params, d.image);
            await this.db.withShop(shop.id, (tx) => tx.query(
              `UPDATE forward_sends SET status = 'sent', force = false, tries = $2, error = NULL, wa_message_id = $3, sent_at = $4 WHERE bill_id = $1`,
              [d.bill_id, d.tries + 1, wamid, now]));
            out.sent++;
          } catch (e) {
            const msg = String((e as Error).message).slice(0, 500);
            const giveUp = now.getTime() - d.created_at.getTime() > GIVE_UP_MS;
            await this.db.withShop(shop.id, (tx) => tx.query(
              `UPDATE forward_sends SET status = $2, tries = $3, error = $4, retry_at = $5 WHERE bill_id = $1`,
              [d.bill_id, giveUp ? 'failed' : 'waiting', d.tries + 1, msg, new Date(now.getTime() + RETRY_MS)]));
            if (giveUp) out.failed++; else out.waiting++;
            this.log.warn(`forward bill ${d.bill_id} not sent: ${msg}`);
          }
        }
        if (sms) await this.tickSms(shop, now, out.sms);
      }
    } finally {
      this.running = false;
    }
    return out;
  }

  /** The SMS half of a pass for one shop: name, firm, slip no, boxes and the bill link. */
  private async tickSms(shop: { id: string; name: string }, now: Date, out: { sent: number; failed: number; waiting: number }) {
    const due = await this.db.withShop(shop.id, async (tx) => (await tx.query<{
      bill_id: string; phone: string; sms_tries: number; created_at: Date; slip_no: number | null; number: string; buyer_name: string; code: string | null; boxes: string;
    }>(
      `WITH taken AS (
         UPDATE forward_sends SET sms_status = 'sending' WHERE bill_id IN (
           SELECT fs.bill_id FROM forward_sends fs JOIN ${LIVE_BILLS} lb ON lb.id = fs.bill_id
           WHERE fs.sms_status = 'waiting' AND fs.sms_retry_at <= $1
             AND fs.sms_force
           LIMIT 20 FOR UPDATE OF fs SKIP LOCKED)
         RETURNING bill_id, phone, sms_tries, created_at)
       SELECT t.bill_id, t.phone, t.sms_tries, t.created_at, b.slip_no, b.number, b.buyer_name,
              (SELECT code FROM bill_links k WHERE k.shop_id = $2 AND k.bill_id = t.bill_id) AS code,
              (SELECT COALESCE(SUM(qty), 0) FROM bill_lines l WHERE l.bill_id = t.bill_id) AS boxes
       FROM taken t JOIN bills b ON b.id = t.bill_id`, [now, shop.id])).rows);
    const base = config().PUBLIC_URL.replace(/\/+$/, '');
    for (const d of due) {
      const vars = [
        smsVar(d.buyer_name || 'Grahak'), smsVar(shop.name), smsVar(d.slip_no ? `${d.slip_no}` : d.number), smsVar(String(Number(d.boxes))),
        d.code ? `${base}/b/${d.code}` : base,
      ];
      try {
        const id = await this.smsSender(d.phone, vars);
        await this.db.withShop(shop.id, (tx) => tx.query(
          `UPDATE forward_sends SET sms_status = 'sent', sms_force = false, sms_tries = $2, sms_error = NULL, sms_id = $3, sms_sent_at = $4 WHERE bill_id = $1`,
          [d.bill_id, d.sms_tries + 1, id, now]));
        out.sent++;
      } catch (e) {
        const msg = String((e as Error).message).slice(0, 500);
        const giveUp = now.getTime() - d.created_at.getTime() > GIVE_UP_MS;
        await this.db.withShop(shop.id, (tx) => tx.query(
          `UPDATE forward_sends SET sms_status = $2, sms_tries = $3, sms_error = $4, sms_retry_at = $5 WHERE bill_id = $1`,
          [d.bill_id, giveUp ? 'failed' : 'waiting', d.sms_tries + 1, msg, new Date(now.getTime() + RETRY_MS)]));
        if (giveUp) out.failed++; else out.waiting++;
        this.log.warn(`slip sms ${d.bill_id} not sent: ${msg}`);
      }
    }
  }

  /** 2Factor transactional SMS on the DLT template: GET /API/R1/?module=TRANS_SMS, var1… in the template's order. */
  private async sendSms(to: string, vars: string[]): Promise<string> {
    const c = config();
    if (!this.smsOn()) throw new Error('SMS abhi chalu nahi hai');
    const q = new URLSearchParams({ module: 'TRANS_SMS', apikey: c.TWOFACTOR_API_KEY!, to: `91${to}`, from: c.CHEEKU_SMS_SENDER, templatename: c.CHEEKU_SMS_TEMPLATE });
    vars.forEach((v, i) => q.set(`var${i + 1}`, v));
    const r = await fetch(`https://2factor.in/API/R1/?${q}`, { signal: AbortSignal.timeout(10_000) });
    const body = (await r.json().catch(() => ({}))) as { Status?: string; Details?: string };
    if (!r.ok || body.Status !== 'Success') throw new Error(`SMS ${r.status}: ${body.Details ?? 'no answer'}`);
    return String(body.Details ?? '');
  }
}
