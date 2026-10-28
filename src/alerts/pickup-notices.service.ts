import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { uuidv7 } from '../common/uuid';
import { config } from '../config';
import { Db } from '../db/db.service';
import { TemplateUnavailable, UdhaarAlertsService } from './udhaar-alerts.service';

/** Sends the "maal de diya" template; swapped out in tests. */
export type PickupSender = (to: string, params: string[]) => Promise<string>;

const QUIET_MS = 40_000;
const FRESH = '30 minutes';
const RETRY_FOR_MS = 3 * 3_600_000;

/** "28 Oct, 3:42 pm" in India. */
function clock(at: Date): string {
  const d = at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  const t = at.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).toLowerCase();
  return `${d}, ${t}`;
}

/**
 * Angoor: the grahak's WhatsApp after the labour hands over boxes against their slip — from the
 * website's scanner or the app's, since both land in pickups. Each slip's scans are gathered until
 * the gaadi goes quiet for a moment, then one message: the slip, the boxes just given, what is
 * still to come, the time. Scans carried onto an edited slip are not new and say nothing; a slip
 * with no grahak number is noted and skipped. The row is written before the send, so a restart
 * never sends twice; while Meta still reviews the template it waits and tries again for 3 hours.
 */
@Injectable()
export class PickupNoticesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('PickupNotices');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  sender: PickupSender = (to, params) => this.alerts.template(to, config().PICKUP_TEMPLATE, params);

  constructor(private readonly db: Db, private readonly alerts: UdhaarAlertsService) {}

  onApplicationBootstrap() {
    if (!this.alerts.canSend() || !config().PICKUP_TEMPLATE) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.warn(`tick: ${(e as Error).message}`)), 20_000);
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(now = new Date()): Promise<{ sent: number; skipped: number; waiting: number; failed: number }> {
    const out = { sent: 0, skipped: 0, waiting: 0, failed: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      const shops = await this.db.query<{ id: string; name: string }>(`SELECT id, name FROM shops WHERE commodity = 'angoor' AND approved_at IS NOT NULL`);
      for (const shop of shops) {
        const due = await this.db.withShop(shop.id, async (tx) => (await tx.query<{
          bill_id: string; last: Date; upto: string; qty: string; slip_no: number | null; number: string; buyer_name: string; phone: string | null; boxes: string; picked: string;
        }>(
          `WITH covered AS (SELECT bill_id, MAX(upto) AS upto FROM pickup_notices WHERE shop_id = $1 GROUP BY bill_id),
                fresh AS (
                  SELECT p.bill_id, MAX(p.received_at) AS last, SUM(p.qty) AS qty
                  FROM pickups p
                  LEFT JOIN covered c ON c.bill_id = p.bill_id
                  WHERE p.received_at > $2::timestamptz - interval '${FRESH}'
                    AND p.received_at > COALESCE(c.upto, '-infinity')
                    -- carried over from the slip this one replaced (same scan time and boxes on a voided slip)
                    AND NOT EXISTS (SELECT 1 FROM pickups o JOIN bill_voids ov ON ov.bill_id = o.bill_id
                                    WHERE o.bill_id <> p.bill_id AND o.created_at = p.created_at AND o.qty = p.qty)
                    AND NOT EXISTS (SELECT 1 FROM bill_voids v WHERE v.bill_id = p.bill_id)
                  GROUP BY p.bill_id)
           SELECT f.bill_id, f.last, f.last::text AS upto, f.qty, b.slip_no, b.number, b.buyer_name, u.phone,
                  (SELECT COALESCE(SUM(qty), 0) FROM bill_lines l WHERE l.bill_id = f.bill_id) AS boxes,
                  (SELECT COALESCE(SUM(qty), 0) FROM pickups k WHERE k.bill_id = f.bill_id) AS picked
           FROM fresh f JOIN bills b ON b.id = f.bill_id LEFT JOIN buyers u ON u.id = b.buyer_id
           WHERE f.last < $2::timestamptz - interval '${QUIET_MS / 1000} seconds'`, [shop.id, now])).rows);

        for (const d of due) {
          const phone = /^[6-9]\d{9}$/.test(d.phone ?? '') ? d.phone! : '';
          const boxes = Number(d.boxes), picked = Number(d.picked), qty = Number(d.qty), left = Math.max(0, boxes - picked);
          const params = [
            d.buyer_name.trim() || 'जी',
            shop.name,
            d.slip_no ? `#${d.slip_no}` : d.number,
            String(qty),
            left > 0 ? `${boxes} में से ${picked} बॉक्स दिए, ${left} बाकी` : `पूरा माल दे दिया (${boxes} बॉक्स)`,
            clock(d.last),
          ];
          const id = uuidv7();
          await this.db.query(
            `INSERT INTO pickup_notices (id, shop_id, bill_id, upto, boxes, phone, status, params) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            // As text: a JS Date drops the microseconds and the last scan would count as new again.
            [id, shop.id, d.bill_id, d.upto, qty, phone, phone ? 'sending' : 'skipped', params]);
          if (!phone) { out.skipped++; continue; }
          await this.attempt(id, phone, params, 0, out);
        }
      }
      // Waiting on Meta's approval: tried again every 10 minutes for 3 hours, then dropped.
      const retry = await this.db.query<{ id: string; phone: string; params: string[]; tries: number; created_at: Date }>(
        `UPDATE pickup_notices SET status = 'sending' WHERE id IN (
           SELECT id FROM pickup_notices WHERE status = 'waiting' AND retry_at <= $1 LIMIT 20 FOR UPDATE SKIP LOCKED)
         RETURNING id, phone, params, tries, created_at`, [now]);
      for (const r of retry) {
        if (now.getTime() - r.created_at.getTime() > RETRY_FOR_MS) {
          await this.db.query(`UPDATE pickup_notices SET status = 'failed', error = 'template not approved in time' WHERE id = $1`, [r.id]);
          out.failed++;
        } else await this.attempt(r.id, r.phone, r.params, r.tries, out);
      }
    } finally {
      this.running = false;
    }
    return out;
  }

  private async attempt(id: string, phone: string, params: string[], tries: number, out: { sent: number; waiting: number; failed: number }) {
    try {
      const wamid = await this.sender(`91${phone}`, params);
      await this.db.query(`UPDATE pickup_notices SET status = 'sent', wa_message_id = $2, tries = $3, error = NULL WHERE id = $1`, [id, wamid, tries + 1]);
      out.sent++;
    } catch (e) {
      const msg = String((e as Error).message).slice(0, 500);
      const wait = e instanceof TemplateUnavailable || tries < 2;
      await this.db.query(`UPDATE pickup_notices SET status = $2, tries = $3, retry_at = $4, error = $5 WHERE id = $1`,
        [id, wait ? 'waiting' : 'failed', tries + 1, new Date(Date.now() + (e instanceof TemplateUnavailable ? 10 : 2) * 60_000), msg]);
      if (wait) out.waiting++; else out.failed++;
      this.log.warn(`pickup notice ${id} not sent: ${msg}`);
    }
  }
}
