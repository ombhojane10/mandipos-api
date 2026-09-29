import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Principal } from '../auth/tokens.service';
import { uuidv7 } from '../common/uuid';
import { Db, Tx } from '../db/db.service';

export type SlipRequest = {
  id: string; buyerName: string; totalPaise: number; detail: unknown; status: string;
  requestedBy: { id: string; name: string; phone: string }; createdAt: string;
  decidedAt: string | null; billId: string | null; mine: boolean;
};

/**
 * Slips above the shop's limit, waiting for an admin. Roles are read from shop_members on
 * every call, so an accountant can never approve their own request, whatever their token says.
 */
@Injectable()
export class RequestsService {
  constructor(private readonly db: Db) {}

  async create(p: Principal, buyerName: string, totalPaise: number, detail: unknown): Promise<SlipRequest> {
    return this.db.tx(async (tx) => {
      await this.roleOf(tx, p);
      const id = uuidv7();
      await tx.query(
        `INSERT INTO slip_requests (id, shop_id, requested_by, device_id, buyer_name, total_paise, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, p.shopId, p.userId, p.deviceId, buyerName, totalPaise, JSON.stringify(detail ?? {})],
      );
      return (await this.list(tx, p, 'r.id = $2', [id]))[0];
    });
  }

  /** An admin sees the shop's requests; an accountant sees their own. Pending first, then the latest 30 decided. */
  async all(p: Principal): Promise<{ requests: SlipRequest[]; youAreAdmin: boolean }> {
    return this.db.tx(async (tx) => {
      const admin = (await this.roleOf(tx, p)) === 'owner';
      const scope = admin ? 'TRUE' : 'r.requested_by = $2';
      const pending = await this.list(tx, p, `${scope} AND r.status = 'pending'`, admin ? [] : [p.userId]);
      const rest = await this.list(tx, p, `${scope} AND r.status <> 'pending'`, admin ? [] : [p.userId], 30);
      return { requests: [...pending, ...rest], youAreAdmin: admin };
    });
  }

  async one(p: Principal, id: string): Promise<SlipRequest> {
    return this.db.tx(async (tx) => {
      const admin = (await this.roleOf(tx, p)) === 'owner';
      const r = (await this.list(tx, p, 'r.id = $2', [id]))[0];
      if (!r || (!admin && !r.mine)) throw new NotFoundException('Request nahi mili');
      return r;
    });
  }

  /** Admin: approve or reject a pending request. */
  async decide(p: Principal, id: string, approve: boolean): Promise<SlipRequest> {
    return this.db.tx(async (tx) => {
      if ((await this.roleOf(tx, p)) !== 'owner') throw new ForbiddenException('Yeh sirf admin kar sakte hain');
      const done = await tx.query(
        `UPDATE slip_requests SET status = $3, decided_by = $4, decided_at = now()
         WHERE shop_id = $1 AND id = $2 AND status = 'pending'`,
        [p.shopId, id, approve ? 'approved' : 'rejected', p.userId],
      );
      if (!done.rowCount) throw new BadRequestException('Yeh request pehle hi tay ho chuki hai');
      return (await this.list(tx, p, 'r.id = $2', [id]))[0];
    });
  }

  /** The requester's terminal wrote the approved slip: the request is spent. */
  async used(p: Principal, id: string, billId: string) {
    return this.db.tx(async (tx) => {
      await this.roleOf(tx, p);
      const done = await tx.query(
        `UPDATE slip_requests SET status = 'used', bill_id = $4
         WHERE shop_id = $1 AND id = $2 AND requested_by = $3 AND status = 'approved'`,
        [p.shopId, id, p.userId, billId],
      );
      if (!done.rowCount) throw new BadRequestException('Yeh request manzoor nahi hai');
    });
  }

  private async list(tx: Tx, p: Principal, where: string, params: unknown[], limit = 200): Promise<SlipRequest[]> {
    const { rows } = await tx.query<{
      id: string; buyer_name: string; total_paise: string; detail: unknown; status: string; requested_by: string;
      name: string; phone: string; created_at: Date; decided_at: Date | null; bill_id: string | null;
    }>(
      `SELECT r.id, r.buyer_name, r.total_paise, r.detail, r.status, r.requested_by, u.name, u.phone, r.created_at, r.decided_at, r.bill_id
       FROM slip_requests r JOIN users u ON u.id = r.requested_by
       WHERE r.shop_id = $1 AND ${where} ORDER BY r.created_at DESC LIMIT ${limit}`,
      [p.shopId, ...params],
    );
    return rows.map((r) => ({
      id: r.id, buyerName: r.buyer_name, totalPaise: Number(r.total_paise), detail: r.detail, status: r.status,
      requestedBy: { id: r.requested_by, name: r.name, phone: r.phone }, createdAt: r.created_at.toISOString(),
      decidedAt: r.decided_at?.toISOString() ?? null, billId: r.bill_id, mine: r.requested_by === p.userId,
    }));
  }

  private async roleOf(tx: Tx, p: Principal): Promise<string> {
    if (!p.shopId) throw new ForbiddenException('Pehle dukaan se judein');
    const r = (await tx.query<{ role: string }>(`SELECT role FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [p.shopId, p.userId])).rows[0];
    if (!r) throw new ForbiddenException('Aap is dukaan ki team mein nahi hain');
    return r.role;
  }
}
