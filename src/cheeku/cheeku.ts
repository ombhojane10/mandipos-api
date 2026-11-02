import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { Principal } from '../auth/tokens.service';
import { isCheeku } from '../common/commodity';
import { Db, Tx } from '../db/db.service';

/**
 * Cheeku (sapota) Fruits: its own copy of everything the angoor (grapes) flow does. It began as
 * an exact copy of the grapes code and is kept apart on purpose — nothing here calls grape code
 * and no grape code calls in here, so the two can change independently. Shared platform only:
 * login, sync, the database tables, printing, and the plain helpers every commodity uses.
 */

/** Cheeku shops write every name in capitals, as their books always have (the angoor rule, its own copy). */
export const CHEEKU_CAPS_NAMES = true;

/** The 1% APMC on goods, in basis points. */
export const CHEEKU_APMC_BPS = 100;

/** Mazdoori a box when a slip doesn't say (₹10). */
export const CHEEKU_LABOUR_PAISE_PER_BOX = 1000;

/** How Bolo is told what the shop sells. */
export const CHEEKU_VOICE_COMMODITY = 'cheeku (sapota), sold per box';

export const NOT_CHEEKU = 'Yeh sirf Cheeku dukaan ke liye hai';

/** Refuses (422) a shop that isn't cheeku: every cheeku-only endpoint starts here. */
export async function requireCheeku(db: Db, shopId: string): Promise<void> {
  const r = await db.one<{ commodity: string }>(`SELECT commodity FROM shops WHERE id = $1`, [shopId]);
  if (!r || !isCheeku(r.commodity)) throw new UnprocessableEntityException(NOT_CHEEKU);
}

/** The same, inside a transaction already on the shop. */
export async function requireCheekuTx(tx: Tx, shopId: string): Promise<void> {
  const r = (await tx.query<{ commodity: string }>(`SELECT commodity FROM shops WHERE id = $1`, [shopId])).rows[0];
  if (!r || !isCheeku(r.commodity)) throw new UnprocessableEntityException(NOT_CHEEKU);
}

/** A terminal's shop for the cheeku app endpoints, as the beejak endpoints read it (labour may only scan). */
export function cheekuShopOf(p: Principal): string {
  if (!p.shopId) throw new ForbiddenException('Pehle dukaan se judein');
  if (p.role === 'labour') throw new ForbiddenException('Labour login sirf scan kar sakta hai');
  return p.shopId;
}

/** Cheeku on a GST invoice: fresh sapota (nil-rated), by the box; the charges line beside APMC. */
export const CHEEKU_INVOICE = { hsn: '0810 90', item: 'Fresh sapota (cheeku)', unit: 'Box', chargesLabel: 'Mazdoori (labour)' } as const;
