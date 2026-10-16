import { ForbiddenException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { Principal } from '../auth/tokens.service';
import { uuidv7 } from '../common/uuid';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';
import { AdminService } from '../admin/admin.service';
import { SettingsService } from '../admin/settings.service';
import { ledgerPdf } from './ledger-pdf';

export type Due = { buyerId: string; name: string; phone: string; duePaise: number };

/** Sends one template message; returns the WhatsApp message id. Swapped out in tests. */
export type Sender = (to: string, params: string[]) => Promise<string>;
/** Sends the udhaar template with a PDF attached; throws TemplateUnavailable when Meta has not approved it. Swapped out in tests. */
export type DocSender = (to: string, params: string[], pdf: Buffer, filename: string) => Promise<string>;
/** The PDF template is not (yet) approved or was paused: send the text one instead. */
export class TemplateUnavailable extends Error {}

/**
 * The morning udhaar WhatsApp: every grahak with a phone who owes a shop that turned this on
 * gets one message a day with their total, through the MandiPlus bot's number.
 *
 * The total is the same arithmetic the counter app uses — every slip still owing plus purana
 * udhaar, less every vasooli — so the message and the grahak's page never disagree.
 */
@Injectable()
export class UdhaarAlertsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('UdhaarAlerts');
  private timer: NodeJS.Timeout | null = null;
  private doneFor = '';
  private running = false;

  sender: Sender = (to, params) => this.sendTemplate(to, params);
  docSender: DocSender = (to, params, pdf, filename) => this.sendDocTemplate(to, params, pdf, filename);
  /** Learned from the last attempt: false once Meta refused the PDF template (rechecked hourly). */
  private pdfOk: { ok: boolean; at: number } | null = null;

  constructor(private readonly db: Db, private readonly admin: AdminService, private readonly settings: SettingsService) {}

  /** Serving only when switched on and wired: checks every 5 minutes, sends once in the 9–12 IST window. */
  onApplicationBootstrap() {
    if (!this.serverOn()) return;
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
    void this.tick();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  serverOn(): boolean {
    const c = config();
    return c.UDHAAR_ALERTS === 'on' && !!c.WHATSAPP_TOKEN && !!c.WHATSAPP_PHONE_NUMBER_ID;
  }

  private async tick() {
    const { date, hour } = istNow();
    if (hour < 9 || hour >= 12 || this.doneFor === date || this.running) return;
    this.running = true;
    try {
      const r = await this.runDaily(date);
      this.log.log(`udhaar alerts ${date}: ${r.sent} sent, ${r.failed} failed, ${r.skipped} already sent`);
      this.doneFor = date;
    } catch (e) {
      this.log.error(`udhaar alerts ${date} stopped: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Every shop that turned alerts on: each owing grahak once for [date]. Safe to call again. */
  async runDaily(date: string): Promise<{ sent: number; failed: number; skipped: number }> {
    const shops = await this.db.query<{ id: string; name: string; phone: string }>(
      `SELECT id, name, phone FROM shops WHERE udhaar_alerts = true`);
    let sent = 0, failed = 0, skipped = 0;
    for (const shop of shops) {
      const dues = await this.db.withShop(shop.id, (tx) => this.dues(tx));
      for (const d of dues) {
        // The log row goes in first; if it is already there for today, this customer is done.
        const claimed = await this.db.query<{ id: string }>(
          `INSERT INTO udhaar_alerts (id, shop_id, buyer_id, alert_date, phone, due_paise)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (shop_id, buyer_id, alert_date) DO NOTHING RETURNING id`,
          [uuidv7(), shop.id, d.buyerId, date, d.phone, d.duePaise]);
        if (!claimed.length) { skipped++; continue; }
        try {
          const id = await this.sender(`91${d.phone}`, [d.name, shop.name, rupees(d.duePaise), shop.phone || shop.name]);
          await this.db.query(`UPDATE udhaar_alerts SET status = 'sent', wa_message_id = $2 WHERE id = $1`, [claimed[0].id, id]);
          sent++;
        } catch (e) {
          await this.db.query(`UPDATE udhaar_alerts SET status = 'failed', error = $2 WHERE id = $1`,
            [claimed[0].id, String((e as Error).message).slice(0, 500)]);
          failed++;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    return { sent, failed, skipped };
  }

  /** Who owes the shop in [tx]'s scope, largest first — grahak with a 10-digit mobile only. */
  async dues(tx: Tx): Promise<Due[]> {
    const { rows } = await tx.query<{ id: string; name: string; phone: string; due: string }>(
      `WITH owed AS (
         SELECT b.buyer_id, b.total_paise - b.paid_paise AS amt FROM bills b
          WHERE b.buyer_id IS NOT NULL AND b.total_paise > b.paid_paise
            AND NOT EXISTS (SELECT 1 FROM bill_voids v WHERE v.bill_id = b.id)
         UNION ALL SELECT buyer_id, amount_paise FROM udhaar_entries
         UNION ALL SELECT c.buyer_id, -c.amount_paise FROM collections c
                    WHERE NOT EXISTS (SELECT 1 FROM collection_voids v WHERE v.collection_id = c.id)
       ), per AS (SELECT buyer_id, SUM(amt) AS due FROM owed GROUP BY buyer_id)
       SELECT g.id, g.name, g.phone, per.due FROM per JOIN buyers g ON g.id = per.buyer_id
        WHERE per.due > 0 AND g.hidden = false AND g.phone ~ '^[6-9][0-9]{9}$'
        ORDER BY per.due DESC`);
    return rows.map((r) => ({ buyerId: r.id, name: r.name, phone: r.phone, duePaise: Number(r.due) }));
  }

  /** Admin: whether it is on, whether the server sends at all, and who would get a message today. */
  async preview(p: Principal) {
    await this.requireAdmin(p);
    const shop = await this.db.one<{ udhaar_alerts: boolean }>(`SELECT udhaar_alerts FROM shops WHERE id = $1`, [p.shopId]);
    const dues = await this.db.withShop(p.shopId!, (tx) => this.dues(tx));
    return { on: !!shop?.udhaar_alerts, serverOn: this.serverOn(), recipients: dues };
  }

  /**
   * Admin: send one grahak their message now — to check the wording and the number before
   * turning the morning run on. Not counted as that day's message, so tomorrow's still goes.
   */
  async sendTest(p: Principal, buyerId: string): Promise<{ messageId: string; duePaise: number }> {
    await this.requireAdmin(p);
    if (!this.serverOn()) throw new ForbiddenException('WhatsApp alerts are switched off on the server');
    const shop = await this.db.one<{ name: string; phone: string }>(`SELECT name, phone FROM shops WHERE id = $1`, [p.shopId]);
    const due = (await this.db.withShop(p.shopId!, (tx) => this.dues(tx))).find((d) => d.buyerId === buyerId);
    if (!due || !shop) throw new ForbiddenException('This grahak has no udhaar, or no 10-digit phone');
    const messageId = await this.sender(`91${due.phone}`, [due.name, shop.name, rupees(due.duePaise), shop.phone || shop.name]);
    return { messageId, duePaise: due.duePaise };
  }

  /** The bot can send at all: its token and number are set (the morning run also needs UDHAAR_ALERTS=on). */
  canSend(): boolean {
    const c = config();
    return !!c.WHATSAPP_TOKEN && !!c.WHATSAPP_PHONE_NUMBER_ID;
  }

  /**
   * The owner's "send this grahak their udhaar on WhatsApp", from the portal or Bolo: the same
   * approved template and total as the morning message, to one grahak, now. Logged before it
   * goes; a second send to the same grahak within 10 minutes is refused, so a double tap or a
   * repeated voice command never sends twice.
   */
  async sendNow(shopId: string, buyerId: string, sentBy: string): Promise<{ messageId: string; duePaise: number; phone: string; name: string; withPdf: boolean }> {
    if (!this.canSend()) throw new ServiceUnavailableException('WhatsApp abhi chalu nahi hai');
    const shop = await this.db.one<{ name: string; phone: string }>(`SELECT name, phone FROM shops WHERE id = $1`, [shopId]);
    if (!shop) throw new ForbiddenException('Dukaan nahi mili');
    const buyer = await this.db.withShop(shopId, async (tx) => (await tx.query<{ name: string; phone: string; hidden: boolean }>(
      `SELECT name, phone, hidden FROM buyers WHERE id = $1`, [buyerId])).rows[0]);
    if (!buyer) throw new UnprocessableEntityException('Grahak nahi mila');
    if (!/^[6-9]\d{9}$/.test(buyer.phone)) throw new UnprocessableEntityException(`${buyer.name} ka 10 ank ka mobile number nahi hai`);
    const due = (await this.db.withShop(shopId, (tx) => this.dues(tx))).find((d) => d.buyerId === buyerId);
    if (!due) throw new UnprocessableEntityException(`${buyer.name} par koi udhaar baaki nahi`);
    const recent = await this.db.one<{ at: Date }>(
      `SELECT created_at AS at FROM whatsapp_sends WHERE shop_id = $1 AND buyer_id = $2 AND status <> 'failed'
         AND created_at > now() - interval '10 minutes' ORDER BY created_at DESC LIMIT 1`, [shopId, buyerId]);
    if (recent) throw new UnprocessableEntityException(`${buyer.name} ko abhi-abhi bheja gaya hai — 10 minute baad dobara bhejein`);
    const id = uuidv7();
    await this.db.query(`INSERT INTO whatsapp_sends (id, shop_id, buyer_id, phone, due_paise, sent_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, shopId, buyerId, due.phone, due.duePaise, sentBy]);
    const params = [due.name, shop.name, rupees(due.duePaise), shop.phone || shop.name];
    try {
      // The khata PDF goes with it once Meta has approved the PDF template; until then, the text one.
      let messageId = '', withPdf = false;
      if (this.pdfLikely()) {
        try {
          const pdf = await this.khataPdf(shopId, buyerId);
          messageId = await this.docSender(`91${due.phone}`, params, pdf, `Khata-${due.name.replace(/[^\p{L}\p{N}]+/gu, '-')}.pdf`);
          withPdf = true;
          this.pdfOk = { ok: true, at: Date.now() };
        } catch (e) {
          if (!(e instanceof TemplateUnavailable)) throw e;
          this.pdfOk = { ok: false, at: Date.now() };
        }
      }
      if (!withPdf) messageId = await this.sender(`91${due.phone}`, params);
      await this.db.query(`UPDATE whatsapp_sends SET status = 'sent', wa_message_id = $2, with_pdf = $3 WHERE id = $1`, [id, messageId, withPdf]);
      return { messageId, duePaise: due.duePaise, phone: due.phone, name: due.name, withPdf };
    } catch (e) {
      await this.db.query(`UPDATE whatsapp_sends SET status = 'failed', error = $2 WHERE id = $1`, [id, String((e as Error).message).slice(0, 500)]);
      this.log.warn(`udhaar WhatsApp to ${due.phone} failed: ${(e as Error).message}`);
      throw new ServiceUnavailableException('WhatsApp nahi gaya — thodi der baad dobara bhejein');
    }
  }

  /** What "WhatsApp bhejein" would send this grahak: the template's own words with their figures. */
  async draft(shopId: string, buyerId: string) {
    const shop = await this.db.one<{ name: string; phone: string }>(`SELECT name, phone FROM shops WHERE id = $1`, [shopId]);
    const buyer = await this.db.withShop(shopId, async (tx) => (await tx.query<{ name: string; phone: string }>(
      `SELECT name, phone FROM buyers WHERE id = $1`, [buyerId])).rows[0]);
    const due = (await this.db.withShop(shopId, (tx) => this.dues(tx))).find((d) => d.buyerId === buyerId);
    const mobile = !!buyer && /^[6-9]\d{9}$/.test(buyer.phone);
    return {
      canSend: this.canSend() && mobile && !!due,
      reason: !this.canSend() ? 'WhatsApp abhi chalu nahi hai' : !mobile ? 'Mobile number nahi hai' : !due ? 'Koi udhaar baaki nahi' : null,
      phone: buyer?.phone ?? '', duePaise: due?.duePaise ?? 0,
      text: due && shop ? UDHAAR_TEXT(due.name, shop.name, rupees(due.duePaise), shop.phone || shop.name) : '',
      last: await this.lastSent(shopId, buyerId),
      withPdf: this.pdfLikely(),
    };
  }

  /** Whether to try the PDF template: unknown or approved, or refused more than an hour ago. */
  private pdfLikely(): boolean {
    return !this.pdfOk || this.pdfOk.ok || Date.now() - this.pdfOk.at > 3_600_000;
  }

  /** The grahak's khata as the app prints it (LedgerPdf), for WhatsApp and for the dialog's preview. */
  async khataPdf(shopId: string, buyerId: string): Promise<Buffer> {
    const [k, s] = await Promise.all([this.admin.buyer(shopId, buyerId), this.settings.get(shopId)]);
    const mandi = s.mandi && !/mandi/i.test(s.mandi) ? `${s.mandi} Mandi` : s.mandi;
    return ledgerPdf({
      firm: { name: s.name, address: s.address || [s.shopNo, mandi].filter(Boolean).join(', '), banks: s.bankAccounts },
      buyer: { name: k.buyer.name, code: k.buyer.code, phone: k.buyer.phone, destination: k.buyer.destination, address: k.buyer.address },
      rows: [...k.history].reverse().map((r) => ({
        date: r.date, particulars: [r.title, r.detail].filter(Boolean).join(' · '), qty: r.nags, debitPaise: r.debitPaise, creditPaise: r.creditPaise,
      })),
      to: istNow().date,
    });
  }

  /** When this grahak was last sent their udhaar on WhatsApp (on demand or the morning run). */
  async lastSent(shopId: string, buyerId: string): Promise<{ at: string; duePaise: number } | null> {
    const r = await this.db.one<{ at: Date; due: string }>(
      `SELECT at, due FROM (
         SELECT created_at AS at, due_paise AS due FROM whatsapp_sends WHERE shop_id = $1 AND buyer_id = $2 AND status = 'sent'
         UNION ALL SELECT created_at, due_paise FROM udhaar_alerts WHERE shop_id = $1 AND buyer_id = $2 AND status = 'sent'
       ) x ORDER BY at DESC LIMIT 1`, [shopId, buyerId]);
    return r ? { at: r.at.toISOString(), duePaise: Number(r.due) } : null;
  }

  /** Admin: turn the morning message on or off for the shop. */
  async setOn(p: Principal, on: boolean) {
    await this.requireAdmin(p);
    await this.db.query(`UPDATE shops SET udhaar_alerts = $2 WHERE id = $1`, [p.shopId, on]);
  }

  private async requireAdmin(p: Principal) {
    if (!p.shopId) throw new ForbiddenException('Join a shop first');
    const m = await this.db.one<{ role: string }>(`SELECT role FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [p.shopId, p.userId]);
    // Any member may: accountants hold every power the owners do.
    if (!m) throw new ForbiddenException('Not a member of this shop');
  }

  /** The PDF uploaded to WhatsApp once, then the udhaar template with it as the document header. */
  private async sendDocTemplate(to: string, params: string[], pdf: Buffer, filename: string): Promise<string> {
    const c = config();
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'application/pdf');
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
    const up = await fetch(`https://graph.facebook.com/v21.0/${c.WHATSAPP_PHONE_NUMBER_ID}/media`, {
      method: 'POST', headers: { Authorization: `Bearer ${c.WHATSAPP_TOKEN}` }, body: form,
    });
    const media = (await up.json().catch(() => ({}))) as { id?: string; error?: { message?: string; code?: number } };
    if (!up.ok || !media.id) throw new Error(`WhatsApp media ${up.status}: ${media.error?.code ?? ''} ${media.error?.message ?? 'no media id'}`);
    const res = await fetch(`https://graph.facebook.com/v21.0/${c.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: c.UDHAAR_PDF_TEMPLATE, language: { code: c.UDHAAR_ALERT_LANG },
          components: [
            { type: 'header', parameters: [{ type: 'document', document: { id: media.id, filename } }] },
            { type: 'body', parameters: params.map((text) => ({ type: 'text', text })) },
          ],
        },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
    // 132000–132016: the template is missing, not approved for this language, or paused.
    const code = body.error?.code ?? 0;
    if (code >= 132000 && code <= 132016) throw new TemplateUnavailable(`${code} ${body.error?.message ?? ''}`);
    if (!res.ok || !body.messages?.[0]?.id) throw new Error(`WhatsApp ${res.status}: ${code} ${body.error?.message ?? 'no message id'}`);
    return body.messages[0].id;
  }

  /** Cloud API template send through the MandiPlus bot's number. */
  private async sendTemplate(to: string, params: string[]): Promise<string> {
    const c = config();
    const res = await fetch(`https://graph.facebook.com/v21.0/${c.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: c.UDHAAR_ALERT_TEMPLATE, language: { code: c.UDHAAR_ALERT_LANG },
          components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
        },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
    if (!res.ok || !body.messages?.[0]?.id) throw new Error(`WhatsApp ${res.status}: ${body.error?.code ?? ''} ${body.error?.message ?? 'no message id'}`);
    return body.messages[0].id;
  }
}

/** udhaar_baaki_reminder_v1's approved body (hi), filled — what the grahak will read. */
const UDHAAR_TEXT = (name: string, shop: string, amount: string, contact: string) =>
  `नमस्ते ${name}, ${shop} में आपका कुल उधार ₹${amount} बाकी है। भुगतान या हिसाब के लिए ${contact} पर संपर्क करें।`;

/** Today's date and hour in India. */
export function istNow(at = new Date()): { date: string; hour: number } {
  const ist = new Date(at.getTime() + 5.5 * 3600_000);
  return { date: ist.toISOString().slice(0, 10), hour: ist.getUTCHours() };
}

/** 1234500 paise → "12,345" (Indian grouping, paise only when there are any). */
export function rupees(paise: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(paise / 100);
}
