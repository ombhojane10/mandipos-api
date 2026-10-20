import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { uuidv7 } from '../common/uuid';
import { config } from '../config';
import { Db } from '../db/db.service';
import { TemplateUnavailable, UdhaarAlertsService, rupees } from './udhaar-alerts.service';

/** What the model heard about the time, as said — the moment itself is worked out here. */
export type When = { day?: number | null; date?: string | null; time?: string | null; after_minutes?: number | null; part?: string | null };
export type Due = { at: Date; label: string } | { ask: 'past' | 'none' | 'far' };
export type Reminder = { id: string; what: string; dueAt: string; label: string; action: 'note' | 'udhaar_whatsapp'; buyerId: string | null; status: string; toPhone: string };

const IST = 330 * 60_000;
const PART: Record<string, number> = { subah: 9, dopahar: 13, shaam: 18, raat: 20 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "kal subah 9:00" / "aaj shaam 6:30" / "Sat 25 Oct, subah 9:00" — how Bolo reads a time back. */
export function whenLabel(at: Date, now = new Date()): string {
  const d = new Date(at.getTime() + IST), today = new Date(now.getTime() + IST);
  const days = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86_400_000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const part = h < 5 ? 'raat' : h < 12 ? 'subah' : h < 16 ? 'dopahar' : h < 20 ? 'shaam' : 'raat';
  const clock = `${h % 12 || 12}:${String(m).padStart(2, '0')}`;
  const day = days === 0 ? 'aaj' : days === 1 ? 'kal' : days === 2 ? 'parson'
    : `${d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return `${day} ${part} ${clock}`;
}

/**
 * The moment a reminder is for, from what was said — never from a timestamp the model wrote
 * (it gets years and zones wrong). A day with no time is 9 a.m.; "subah/dopahar/shaam/raat"
 * alone is 9 / 1 / 6 / 8. A time already gone today with no day said is the same time tomorrow;
 * a moment in the past otherwise, no time at all, or over a year away is a question instead.
 */
export function dueFrom(w: When, now = new Date()): Due {
  if (w.after_minutes && w.after_minutes > 0) {
    if (w.after_minutes > 366 * 24 * 60) return { ask: 'far' };
    const at = new Date(now.getTime() + w.after_minutes * 60_000);
    return { at, label: whenLabel(at, now) };
  }
  const today = new Date(now.getTime() + IST).toISOString().slice(0, 10);
  const dated = !!w.date && /^\d{4}-\d{2}-\d{2}$/.test(w.date);
  const dayGiven = dated || (typeof w.day === 'number' && w.day >= 0);
  const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(w.time ?? '');
  const hour = clock ? Number(clock[1]) : w.part && PART[w.part] !== undefined ? PART[w.part] : null;
  if (!dayGiven && hour === null) return { ask: 'none' };
  const minute = clock ? Number(clock[2]) : 0;
  const base = dated ? w.date! : new Date(Date.parse(`${today}T00:00:00Z`) + (dayGiven ? w.day! : 0) * 86_400_000).toISOString().slice(0, 10);
  let at = new Date(Date.parse(`${base}T${String(hour ?? 9).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`) - IST);
  if (at.getTime() <= now.getTime()) {
    if (dayGiven) return { ask: 'past' };
    at = new Date(at.getTime() + 86_400_000);
  }
  if (at.getTime() - now.getTime() > 366 * 86_400_000) return { ask: 'far' };
  return { at, label: whenLabel(at, now) };
}

/** Sends one reminder template; swapped out in tests. */
export type ReminderSender = (to: string, params: string[]) => Promise<string>;

/**
 * Reminders set by voice. Saved with the moment worked out here, read back from what was saved,
 * and sent by the server's own timer from the MandiPlus bot's number — to the person who set it,
 * or (udhaar_whatsapp) the grahak's udhaar to the grahak. A send that fails because the template
 * is still awaiting Meta's approval waits and tries again for a day.
 */
@Injectable()
export class RemindersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Reminders');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  sender: ReminderSender = (to, params) => this.alerts.template(to, config().REMINDER_TEMPLATE, params);

  constructor(private readonly db: Db, private readonly alerts: UdhaarAlertsService) {}

  onApplicationBootstrap() {
    if (!this.alerts.canSend()) return;
    this.timer = setInterval(() => void this.tick(), 30_000);
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async create(shopId: string, by: string, r: { toPhone: string; what: string; at: Date; buyerId?: string | null; action?: 'note' | 'udhaar_whatsapp' }): Promise<Reminder> {
    const id = uuidv7();
    const row = await this.db.one<Row>(
      `INSERT INTO reminders (id, shop_id, created_by, to_phone, what, buyer_id, action, due_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, shopId, by, r.toPhone, r.what.trim().slice(0, 300), r.buyerId ?? null, r.action ?? 'note', r.at]);
    return view(row!);
  }

  /** Still to go, soonest first. */
  async upcoming(shopId: string): Promise<Reminder[]> {
    const rows = await this.db.query<Row>(`SELECT * FROM reminders WHERE shop_id = $1 AND status IN ('pending', 'sending') ORDER BY due_at LIMIT 50`, [shopId]);
    return rows.map((r) => view(r));
  }

  async cancel(shopId: string, id: string): Promise<boolean> {
    const r = await this.db.query(`UPDATE reminders SET status = 'cancelled' WHERE shop_id = $1 AND id = $2 AND status = 'pending' RETURNING id`, [shopId, id]);
    return r.length > 0;
  }

  /** Everything due: claimed (so two runs never send one twice), sent, and marked. */
  async tick(now = new Date()): Promise<{ sent: number; failed: number; waiting: number }> {
    if (this.running) return { sent: 0, failed: 0, waiting: 0 };
    this.running = true;
    let sent = 0, failed = 0, waiting = 0;
    try {
      const due = await this.db.query<Row>(
        `UPDATE reminders SET status = 'sending', tries = tries + 1 WHERE id IN (
           SELECT id FROM reminders WHERE status = 'pending' AND COALESCE(retry_at, due_at) <= $1 ORDER BY due_at LIMIT 20 FOR UPDATE SKIP LOCKED)
         RETURNING *`, [now]);
      for (const r of due) {
        try {
          const id = await this.send(r, now);
          await this.db.query(`UPDATE reminders SET status = 'sent', wa_message_id = $2, sent_at = now(), error = NULL WHERE id = $1`, [r.id, id]);
          sent++;
        } catch (e) {
          const msg = String((e as Error).message).slice(0, 500);
          // Not approved yet: try every 10 minutes for a day. Anything else: twice more, 5 minutes apart.
          const late = now.getTime() - r.due_at.getTime();
          const again = e instanceof TemplateUnavailable ? late < 86_400_000 : r.tries < 3;
          if (again) {
            await this.db.query(`UPDATE reminders SET status = 'pending', retry_at = $2, error = $3 WHERE id = $1`,
              [r.id, new Date(now.getTime() + (e instanceof TemplateUnavailable ? 10 : 5) * 60_000), msg]);
            waiting++;
          } else {
            await this.db.query(`UPDATE reminders SET status = 'failed', error = $2 WHERE id = $1`, [r.id, msg]);
            failed++;
          }
          this.log.warn(`reminder ${r.id} not sent: ${msg}`);
        }
      }
    } finally {
      this.running = false;
    }
    return { sent, failed, waiting };
  }

  private async send(r: Row, now: Date): Promise<string> {
    if (r.action === 'udhaar_whatsapp' && r.buyer_id) return (await this.alerts.sendNow(r.shop_id, r.buyer_id, r.created_by)).messageId;
    const shop = await this.db.one<{ name: string }>(`SELECT name FROM shops WHERE id = $1`, [r.shop_id]);
    const who = await this.db.one<{ name: string }>(`SELECT name FROM users WHERE phone = $1`, [r.to_phone]);
    let detail = `यह रिमाइंडर ${whenLabel(r.created_at, now).replace(/^aaj /, 'आज ')} सेट किया गया था`;
    if (r.buyer_id) {
      const due = (await this.db.withShop(r.shop_id, (tx) => this.alerts.dues(tx))).find((d) => d.buyerId === r.buyer_id);
      const b = await this.db.withShop(r.shop_id, async (tx) => (await tx.query<{ name: string; phone: string }>(`SELECT name, phone FROM buyers WHERE id = $1`, [r.buyer_id])).rows[0]);
      if (b) detail = `${b.name} का उधार ${due ? `अभी ₹${rupees(due.duePaise)} बाकी है` : 'अभी कुछ बाकी नहीं है'}${b.phone ? ` · मोबाइल ${b.phone}` : ''}`;
    }
    return this.sender(`91${r.to_phone}`, [who?.name?.trim() || 'जी', shop?.name ?? 'MandiPlus', r.what, detail]);
  }
}

type Row = { id: string; shop_id: string; created_by: string; to_phone: string; what: string; buyer_id: string | null; action: 'note' | 'udhaar_whatsapp'; due_at: Date; status: string; tries: number; created_at: Date };

function view(r: Row): Reminder {
  return { id: r.id, what: r.what, dueAt: r.due_at.toISOString(), label: whenLabel(r.due_at), action: r.action, buyerId: r.buyer_id, status: r.status, toPhone: r.to_phone };
}
