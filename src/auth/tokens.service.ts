import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { uuidv7 } from '../common/uuid';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';

export const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 60;
/** How long a just-rotated refresh token still answers, for a terminal that raced itself. */
const ROTATION_GRACE_MS = 60_000;

/** What every authenticated request knows about its caller. */
export type Principal = {
  userId: string;
  deviceId: string;
  shopId: string | null;
  role: string | null;
};

type Claims = { sub: string; dev: string; shop: string | null; role: string | null };

export type Tokens = { accessToken: string; refreshToken: string; expiresIn: number };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class TokensService {
  constructor(private readonly db: Db) {}

  signAccess(p: Principal): string {
    const claims: Claims = { sub: p.userId, dev: p.deviceId, shop: p.shopId, role: p.role };
    return jwt.sign(claims, config().JWT_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TTL_SECONDS });
  }

  verifyAccess(token: string): Principal {
    try {
      const c = jwt.verify(token, config().JWT_SECRET, { algorithms: ['HS256'] }) as Claims;
      return { userId: c.sub, deviceId: c.dev, shopId: c.shop, role: c.role };
    } catch {
      throw new UnauthorizedException('Session expire ho gaya');
    }
  }

  /** Current shop + role for a device, read fresh (a device may have just joined a shop). */
  async principalFor(tx: Tx, userId: string, deviceId: string): Promise<Principal> {
    const { rows } = await tx.query<{ shop_id: string | null; role: string | null }>(
      `SELECT d.shop_id, m.role FROM devices d
       LEFT JOIN shop_members m ON m.shop_id = d.shop_id AND m.user_id = d.user_id
       WHERE d.id = $1 AND d.user_id = $2`,
      [deviceId, userId],
    );
    return { userId, deviceId, shopId: rows[0]?.shop_id ?? null, role: rows[0]?.role ?? null };
  }

  /** Opens a new session for a device and returns its first token pair. */
  async issue(tx: Tx, p: Principal): Promise<Tokens> {
    const refreshToken = randomBytes(32).toString('base64url');
    await tx.query(
      `INSERT INTO sessions (id, user_id, device_id, refresh_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
      [uuidv7(), p.userId, p.deviceId, sha256(refreshToken), REFRESH_TTL_DAYS],
    );
    return { accessToken: this.signAccess(p), refreshToken, expiresIn: ACCESS_TTL_SECONDS };
  }

  /**
   * Swaps a refresh token for a new pair.
   *
   * Presenting an already-rotated token usually means it leaked, and every session on that
   * device is revoked. The exception is the terminal racing itself: the foreground sync and
   * the background worker can both refresh within the same moment, and the loser then holds
   * a token that was rotated a second ago. That is not a leak, so a token rotated within
   * [ROTATION_GRACE_MS] is answered from the live end of its chain instead of logging the
   * counter out mid-sale.
   */
  async rotate(refreshToken: string): Promise<Tokens> {
    // A real leak must revoke the device's sessions in a transaction of its own: the rejection
    // rolls the rotation back, which would otherwise undo the revocation with it.
    let leakedDevice: string | null = null;
    try {
      return await this.db.tx(async (tx) => {
        const { rows } = await tx.query<{
          id: string; user_id: string; device_id: string;
          revoked_at: Date | null; expires_at: Date; device_revoked: Date | null;
        }>(
          `SELECT s.id, s.user_id, s.device_id, s.revoked_at, s.expires_at, d.revoked_at AS device_revoked
           FROM sessions s JOIN devices d ON d.id = s.device_id
           WHERE s.refresh_hash = $1 FOR UPDATE OF s`,
          [sha256(refreshToken)],
        );
        const s = rows[0];
        if (!s) throw new UnauthorizedException('Dobara login karein');
        if (s.device_revoked || s.expires_at < new Date()) throw new UnauthorizedException('Dobara login karein');

        // Already rotated: either this terminal racing itself (answer from the live end of
        // the chain) or a replayed token (revoke the device).
        let current = s.id;
        if (s.revoked_at) {
          const heir = Date.now() - s.revoked_at.getTime() < ROTATION_GRACE_MS ? await this.liveHeir(tx, s.id) : null;
          if (!heir) {
            leakedDevice = s.device_id;
            throw new UnauthorizedException('Dobara login karein');
          }
          current = heir;
        }

        const p = await this.principalFor(tx, s.user_id, s.device_id);
        const next = await this.issue(tx, p);
        await tx.query(
          `UPDATE sessions SET revoked_at = now(), replaced_by = (SELECT id FROM sessions WHERE refresh_hash = $2) WHERE id = $1`,
          [current, sha256(next.refreshToken)],
        );
        return next;
      });
    } finally {
      if (leakedDevice) {
        await this.db.query(`UPDATE sessions SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL`, [leakedDevice]);
      }
    }
  }

  /** The still-valid session this one was rotated into, following the chain. */
  private async liveHeir(tx: Tx, sessionId: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>(
      `WITH RECURSIVE chain AS (
         SELECT id, replaced_by, revoked_at FROM sessions WHERE id = $1
         UNION ALL
         SELECT s.id, s.replaced_by, s.revoked_at FROM sessions s JOIN chain c ON s.id = c.replaced_by
       )
       SELECT id FROM chain WHERE revoked_at IS NULL LIMIT 1`,
      [sessionId],
    );
    return rows[0]?.id ?? null;
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.db.query(`UPDATE sessions SET revoked_at = now() WHERE refresh_hash = $1 AND revoked_at IS NULL`, [sha256(refreshToken)]);
  }
}
