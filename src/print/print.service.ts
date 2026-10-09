import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Principal } from '../auth/tokens.service';
import { uuidv7 } from '../common/uuid';
import { Db, Tx } from '../db/db.service';

export type PrintJob = {
  id: string; title: string; widthDots: number; status: string; error: string | null;
  createdAt: string; finishedAt: string | null; station: string | null; mine: boolean;
};

/** roll: the printer the station drives — WIFI means the shop's own WiFi printer. */
export type Station = { online: boolean; name: string; widthDots: number; roll: string; lastSeenAt: string | null; thisDevice: boolean };

/** A station that asked for work within this long is "on". Its long-poll lasts up to 25 s. */
const ONLINE_SECONDS = 45;
/** A slip nobody printed by then is stale; printing it the next morning would only confuse. */
const EXPIRE_HOURS = 12;
/** Claimed but never confirmed: the station died mid-print, so say so rather than print twice. */
const UNCONFIRMED_MINUTES = 2;
/** A station that couldn't reach the printer is handed no slip for this long. */
const COOLDOWN_MINUTES = 10;
/**
 * The apps' own "couldn't reach the printer" message, in each language. Apps from before the
 * requeue flag (0.52) report it as a plain failure; read this way, their slip is given back too.
 */
const UNREACHABLE = /tak nahi pahunche|तक नहीं पहुँचे|couldn't reach the wifi printer/i;
const MAX_IMAGE_BYTES = 400_000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * The shop's print queue. A device anywhere sends a slip image; the shop's station (a machine
 * in the office that stays on) long-polls [next], prints it on the printer beside it, and
 * reports back with [done]. Claiming uses SKIP LOCKED, so two stations never take one slip.
 */
@Injectable()
export class PrintService {
  /** Stations waiting in [next], per shop: a new job wakes them at once instead of on the next tick. */
  private readonly waiting = new Map<string, Set<() => void>>();

  constructor(private readonly db: Db) {}

  async send(p: Principal, title: string, imageBase64: string, widthDots: number): Promise<PrintJob> {
    const image = Buffer.from(imageBase64, 'base64');
    if (image.length > MAX_IMAGE_BYTES) throw new BadRequestException('Parchi ki photo bahut badi hai');
    if (!image.subarray(0, 4).equals(PNG)) throw new BadRequestException('Parchi ki photo PNG nahi hai');
    const job = await this.db.tx(async (tx) => {
      const shopId = await this.member(tx, p);
      const id = uuidv7();
      await tx.query(
        `INSERT INTO print_jobs (id, shop_id, created_by, from_device, title, image, width_dots)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, shopId, p.userId, p.deviceId, title, image, widthDots],
      );
      return (await this.list(tx, p, 'j.id = $2', [id]))[0];
    });
    this.wake(p.shopId!);
    return job;
  }

  async one(p: Principal, id: string): Promise<PrintJob> {
    return this.db.tx(async (tx) => {
      await this.member(tx, p);
      const job = (await this.list(tx, p, 'j.id = $2', [id]))[0];
      if (!job) throw new NotFoundException('Yeh parchi nahi mili');
      return job;
    });
  }

  /** The shop's latest jobs, newest first, for the station's "chhapi gayi" list. */
  async recent(p: Principal): Promise<PrintJob[]> {
    return this.db.tx(async (tx) => {
      await this.member(tx, p);
      return this.list(tx, p, `j.created_at > now() - interval '1 day'`, [], 30);
    });
  }

  /** A failed or expired slip goes back in the queue, as it was. */
  async retry(p: Principal, id: string): Promise<PrintJob> {
    const job = await this.db.tx(async (tx) => {
      await this.member(tx, p);
      const done = await tx.query(
        `UPDATE print_jobs SET status = 'queued', created_at = now(), station = NULL, error = NULL,
                claimed_at = NULL, finished_at = NULL
         WHERE shop_id = $1 AND id = $2 AND status IN ('failed', 'expired') AND image IS NOT NULL`,
        [p.shopId, id],
      );
      if (!done.rowCount) throw new BadRequestException('Yeh parchi dobara nahi bheji ja sakti');
      return (await this.list(tx, p, 'j.id = $2', [id]))[0];
    });
    this.wake(p.shopId!);
    return job;
  }

  /** Whether the shop has a station listening right now, and how wide its printer is. */
  async station(p: Principal): Promise<Station | null> {
    return this.db.tx(async (tx) => {
      const shopId = await this.member(tx, p);
      // A station sitting out (it couldn't reach the printer) is not "on": prefer one that is.
      const r = (await tx.query<{ device_id: string; name: string; width_dots: number; roll: string; last_poll_at: Date; online: boolean }>(
        `SELECT device_id, name, width_dots, roll, last_poll_at,
                last_poll_at > now() - make_interval(secs => $2::int) AND NOT COALESCE(cooldown_until > now(), false) AS online
         FROM print_stations WHERE shop_id = $1
         ORDER BY COALESCE(cooldown_until > now(), false), last_poll_at DESC LIMIT 1`,
        [shopId, ONLINE_SECONDS],
      )).rows[0];
      if (!r) return null;
      return { online: r.online, name: r.name, widthDots: r.width_dots, roll: r.roll, lastSeenAt: r.last_poll_at.toISOString(), thisDevice: r.device_id === p.deviceId };
    });
  }

  /** This device stops printing for the shop. */
  async leave(p: Principal) {
    await this.db.query(`DELETE FROM print_stations WHERE device_id = $1`, [p.deviceId]);
  }

  /**
   * Station: the oldest waiting slip, claimed for this device — or null once [waitSeconds]
   * pass without one. Each call also marks the station online.
   */
  async next(p: Principal, name: string, widthDots: number, waitSeconds: number, gone: () => boolean, roll = ''):
    Promise<{ id: string; title: string; widthDots: number; image: string; createdAt: string } | null> {
    const shopId = await this.db.tx(async (tx) => {
      const shopId = await this.member(tx, p);
      await tx.query(
        `INSERT INTO print_stations (device_id, shop_id, name, width_dots, roll, last_poll_at) VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (device_id) DO UPDATE SET shop_id = $2, name = $3, width_dots = $4, roll = $5, last_poll_at = now()`,
        [p.deviceId, shopId, name, widthDots, roll],
      );
      await this.tidy(tx, shopId);
      return shopId;
    });
    const cooling = (await this.db.query<{ cooling: boolean }>(
      `SELECT COALESCE(cooldown_until > now(), false) AS cooling FROM print_stations WHERE device_id = $1`, [p.deviceId],
    ))[0]?.cooling ?? false;

    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      if (gone()) return null;
      // Sitting out: wait the poll through, claim nothing.
      const job = cooling ? null : await this.claim(shopId, p.deviceId);
      if (job) return job;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await this.sleep(shopId, Math.min(left, 3000));
    }
    await this.db.query(`UPDATE print_stations SET last_poll_at = now() WHERE device_id = $1`, [p.deviceId]);
    return null;
  }

  /**
   * Station: how the slip it claimed went. [requeue]: this device couldn't reach the printer
   * and sent nothing — the slip goes back to the queue for a device that can, and this one
   * stops counting as a station until it asks for work again.
   */
  async done(p: Principal, id: string, ok: boolean, error: string, requeue = false) {
    if (!ok && (requeue || UNREACHABLE.test(error))) {
      const back = await this.db.query<{ shop_id: string }>(
        `UPDATE print_jobs SET status = 'queued', station = NULL, claimed_at = NULL, error = NULL
         WHERE id = $1 AND station = $2 AND status = 'printing' RETURNING shop_id`,
        [id, p.deviceId],
      );
      if (!back.length) throw new BadRequestException('Yeh parchi is machine ke paas nahi thi');
      // It keeps polling (an old app doesn't know to stop), but is handed nothing for a while.
      await this.db.query(
        `UPDATE print_stations SET cooldown_until = now() + make_interval(mins => ${COOLDOWN_MINUTES}) WHERE device_id = $1`,
        [p.deviceId],
      );
      this.wake(back[0].shop_id);
      return;
    }
    if (ok) await this.db.query(`UPDATE print_stations SET cooldown_until = NULL WHERE device_id = $1`, [p.deviceId]);
    const r = await this.db.query(
      `UPDATE print_jobs SET status = $3, error = $4, finished_at = now(),
              image = CASE WHEN $3 = 'printed' THEN NULL ELSE image END
       WHERE id = $1 AND station = $2 AND status = 'printing' RETURNING id`,
      [id, p.deviceId, ok ? 'printed' : 'failed', ok ? null : error.slice(0, 300) || 'Printer ne mana kar diya'],
    );
    if (!r.length) throw new BadRequestException('Yeh parchi is machine ke paas nahi thi');
  }

  // ---------------------------------------------------------------- internals

  private async claim(shopId: string, deviceId: string) {
    const r = (await this.db.query<{ id: string; title: string; width_dots: number; image: Buffer; created_at: Date }>(
      `UPDATE print_jobs SET status = 'printing', station = $2, claimed_at = now()
       WHERE id = (
         SELECT id FROM print_jobs WHERE shop_id = $1 AND status = 'queued'
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id, title, width_dots, image, created_at`,
      [shopId, deviceId],
    ))[0];
    return r ? { id: r.id, title: r.title, widthDots: r.width_dots, image: r.image.toString('base64'), createdAt: r.created_at.toISOString() } : null;
  }

  /** Stale slips expire, unconfirmed ones fail, and old images and rows are dropped. */
  private async tidy(tx: Tx, shopId: string) {
    await tx.query(
      `UPDATE print_jobs SET status = 'expired', finished_at = now(), error = 'Office printer ${EXPIRE_HOURS} ghante tak band raha'
       WHERE shop_id = $1 AND status = 'queued' AND created_at < now() - make_interval(hours => ${EXPIRE_HOURS})`,
      [shopId],
    );
    await tx.query(
      `UPDATE print_jobs SET status = 'failed', finished_at = now(), error = 'Pata nahi chhapi ya nahi — machine ne jawab nahi diya'
       WHERE shop_id = $1 AND status = 'printing' AND claimed_at < now() - make_interval(mins => ${UNCONFIRMED_MINUTES})`,
      [shopId],
    );
    await tx.query(`DELETE FROM print_jobs WHERE shop_id = $1 AND created_at < now() - interval '7 days'`, [shopId]);
  }

  private wake(shopId: string) {
    const set = this.waiting.get(shopId);
    if (!set) return;
    this.waiting.delete(shopId);
    set.forEach((f) => f());
  }

  private sleep(shopId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiting.get(shopId);
      if (!set) this.waiting.set(shopId, (set = new Set()));
      const done = () => { clearTimeout(timer); set!.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      set.add(done);
    });
  }

  private async list(tx: Tx, p: Principal, where: string, params: unknown[], limit = 1): Promise<PrintJob[]> {
    const { rows } = await tx.query<{
      id: string; title: string; width_dots: number; status: string; error: string | null;
      created_at: Date; finished_at: Date | null; station_name: string | null; created_by: string;
    }>(
      `SELECT j.id, j.title, j.width_dots, j.status, j.error, j.created_at, j.finished_at, j.created_by, s.name AS station_name
       FROM print_jobs j LEFT JOIN print_stations s ON s.device_id = j.station
       WHERE j.shop_id = $1 AND ${where} ORDER BY j.created_at DESC LIMIT ${limit}`,
      [p.shopId, ...params],
    );
    return rows.map((r) => ({
      id: r.id, title: r.title, widthDots: r.width_dots, status: r.status, error: r.error,
      createdAt: r.created_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
      station: r.station_name, mine: r.created_by === p.userId,
    }));
  }

  private async member(tx: Tx, p: Principal): Promise<string> {
    if (!p.shopId) throw new ForbiddenException('Pehle dukaan se judein');
    const r = (await tx.query(`SELECT 1 FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [p.shopId, p.userId])).rows[0];
    if (!r) throw new ForbiddenException('Aap is dukaan ki team mein nahi hain');
    return p.shopId;
  }
}
