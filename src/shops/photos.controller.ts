import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthGuard, Me } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse } from '../common/validate';
import { Db, Tx } from '../db/db.service';

const Id = z.uuid();
const PutBody = z.object({ image: z.string().min(8).max(400_000) });
const GetQuery = z.object({ since: z.iso.datetime({ offset: true }).optional() });
const MAX_JPEG_BYTES = 280_000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * A grahak's photo, shown on their card when it is tapped. Taken on one terminal, seen on
 * every terminal of the shop: the taker uploads it here, the others fetch it on a tap.
 */
@Controller('v1/buyers')
@UseGuards(AuthGuard)
export class PhotosController {
  constructor(private readonly db: Db) {}

  @Put(':id/photo')
  @HttpCode(200)
  async put(@Me() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const buyerId = parse(Id, id);
    const jpeg = Buffer.from(parse(PutBody, body).image, 'base64');
    if (jpeg.length > MAX_JPEG_BYTES) throw new BadRequestException('Photo bahut badi hai');
    if (!jpeg.subarray(0, 3).equals(JPEG)) throw new BadRequestException('Photo JPEG nahi hai');
    const shopId = shopOf(p);
    return this.db.withShop(shopId, async (tx) => {
      await member(tx, p, shopId);
      const { rows } = await tx.query<{ updated_at: Date }>(
        `INSERT INTO buyer_photos (buyer_id, shop_id, jpeg) SELECT id, shop_id, $2 FROM buyers WHERE id = $1
         ON CONFLICT (buyer_id) DO UPDATE SET jpeg = EXCLUDED.jpeg, updated_at = now()
         RETURNING updated_at`,
        [buyerId, jpeg],
      );
      if (!rows[0]) throw new NotFoundException('Yeh grahak nahi mila');
      return { updatedAt: rows[0].updated_at.toISOString() };
    });
  }

  /** The JPEG, or 304 when the caller's copy (`since` = its updated time) is still current, or 404. */
  @Get(':id/photo')
  async get(@Me() p: Principal, @Param('id') id: string, @Query() query: unknown, @Res() res: Response) {
    const buyerId = parse(Id, id);
    const { since } = parse(GetQuery, query);
    const shopId = shopOf(p);
    const photo = await this.db.withShop(shopId, async (tx) => {
      await member(tx, p, shopId);
      return (await tx.query<{ jpeg: Buffer; updated_at: Date }>(
        `SELECT jpeg, updated_at FROM buyer_photos WHERE buyer_id = $1`, [buyerId])).rows[0];
    });
    if (!photo) return res.status(404).end();
    if (since && new Date(since).getTime() >= photo.updated_at.getTime()) return res.status(304).end();
    res.status(200).set({ 'Content-Type': 'image/jpeg', 'X-Updated-At': photo.updated_at.toISOString() }).send(photo.jpeg);
  }
}

function shopOf(p: Principal): string {
  if (!p.shopId) throw new ForbiddenException('Pehle dukaan se judein');
  return p.shopId;
}

async function member(tx: Tx, p: Principal, shopId: string) {
  const r = (await tx.query(`SELECT 1 FROM shop_members WHERE shop_id = $1 AND user_id = $2`, [shopId, p.userId])).rows[0];
  if (!r) throw new ForbiddenException('Aap is dukaan ki team mein nahi hain');
}
