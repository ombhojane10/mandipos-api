import { ForbiddenException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Principal } from '../auth/tokens.service';
import { uuidv7 } from '../common/uuid';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';

export type Due = { buyerId: string; name: string; phone: string; duePaise: number };

/** Sends one template message; returns the WhatsApp message id. Swapped out in tests. */
export type Sender = (to: string, params: string[]) => Promise<string>;

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

  constructor(private readonly db: Db) {}

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

/** Today's date and hour in India. */
export function istNow(at = new Date()): { date: string; hour: number } {
  const ist = new Date(at.getTime() + 5.5 * 3600_000);
  return { date: ist.toISOString().slice(0, 10), hour: ist.getUTCHours() };
}

/** 1234500 paise → "12,345" (Indian grouping, paise only when there are any). */
export function rupees(paise: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(paise / 100);
}
