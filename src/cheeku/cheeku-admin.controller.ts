import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, See, mine, type Viewer } from '../admin/admin.controller';
import { EntriesService } from '../admin/entries.service';
import { parse } from '../common/validate';
import { Db } from '../db/db.service';
import { requireCheeku } from './cheeku';
import { CheekuBeejakBody } from './cheeku-app.controller';
import { CheekuCommissionsService } from './cheeku-commissions.service';
import { CheekuCreditorsService } from './cheeku-creditors.service';
import { CheekuDeskService } from './cheeku-desk.service';
import { CheekuEntriesService } from './cheeku-entries.service';
import { CheekuForwardSendsService } from './cheeku-forward-sends.service';
import { CheekuForwardService } from './cheeku-forward.service';
import { CheekuSlipSendsService } from './cheeku-slip-sends.service';
import { LIVE_BILLS, n } from '../admin/sql';

// The grapes admin bodies, each its own copy.
const Day = z.iso.date();
const Range = z.object({ from: Day, to: Day });
const paise = z.number().int().min(0).max(1_000_000_000_00);
const grade = z.enum(['1', '2', '3', 'mix']);
/** A party's commission: % in basis points (6% = 600, at most 50%); null = back to the default. */
const CommissionBody = z.object({ supplier: z.string().trim().max(120).default(''), bps: z.number().int().min(0).max(5000).nullable() });
const FyQuery = z.object({ fy: z.coerce.number().int().min(2000).max(2100).optional() });
const SupplierBody = z.object({
  id: z.uuid().optional(), name: z.string().trim().min(1).max(120), code: z.string().max(20).optional(), area: z.string().max(60).optional(),
  phone: z.string().trim().max(15).optional(), openingPaise: z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00).optional(),
  openingOn: z.iso.date().nullable().optional(),
});
/** Maal sent on: boxes off gaadis at the shop's bhav, the vehicle, and the grahak (a name, and a mobile kept with it). */
const ForwardBody = z.object({
  customer: z.object({ name: z.string().trim().max(60).default(''), mobile: z.string().trim().max(15).default('') }).optional(),
  lots: z.array(z.object({ truckId: z.uuid(), brandId: z.uuid(), qty: z.number().int().min(1).max(10_000_000), ratePaise: paise })).min(1).max(20),
  vehicle: z.string().trim().max(20).default(''), staff: z.string().trim().max(60).optional(),
});
/** The shop's personal bill for a slip sent on: its own rate per quality (by brand id), bhada, mazdoori, commission. */
const PersonalBillBody = z.object({
  rates: z.record(z.uuid(), paise).default({}), bhadaPaise: paise, mazdooriPaise: paise, commissionPaise: paise,
});
const GaadiBody = z.object({
  number: z.string().trim().min(1).max(20), supplier: z.string().trim().max(120).default(''), freightPaise: paise.optional(),
  location: z.string().trim().max(80).optional(),
  lots: z.array(z.object({ brandId: z.uuid().optional(), brandName: z.string().trim().max(60).optional(), grade, qty: z.number().int().min(0).max(10_000_000), ratePaise: paise,
    boxGrams: z.number().int().min(0).max(1_000_000).optional() })).min(1).max(12),
});

/**
 * Cheeku on the website: its own copies of the grapes desk endpoints — the desk, beejaks,
 * supplier creditors and laddan, the gaadi edit, the gaadi scanner's pickups and broken boxes,
 * and the labour page — under /v1/admin/shops/:id/cheeku/…. Each refuses a shop that isn't
 * cheeku (422). The shared entry endpoints (entry-options, entries/parchi, entries/gaadi, bill
 * edits, books) keep their paths and send a cheeku shop to cheeku's code themselves.
 */
@Controller('v1/admin')
@UseGuards(AdminGuard)
export class CheekuAdminController {
  constructor(
    private readonly db: Db, private readonly desk: CheekuDeskService, private readonly creditors: CheekuCreditorsService,
    private readonly entries: CheekuEntriesService, private readonly shared: EntriesService,
    private readonly commissions: CheekuCommissionsService, private readonly forward: CheekuForwardService,
    private readonly forwardSends: CheekuForwardSendsService, private readonly slipSends: CheekuSlipSendsService,
  ) {}

  /**
   * The website's "WhatsApp par bhejein" (after a scan, or from the parchi): the slip as the
   * website drew it, to the number given, with the same words the machine sends. A number typed
   * for a grahak who had none is saved to them, as the app does; Cash / Bank walk-ins keep none.
   */
  @Post('shops/:id/cheeku/bills/:billId/whatsapp')
  @HttpCode(200)
  async slipWhatsapp(@See() v: Viewer, @Param('id') id: string, @Param('billId') billId: string, @Body() body: unknown) {
    const shopId = mine(v, id);
    const bid = parse(z.uuid(), billId);
    const b = parse(z.object({ phone: z.string().trim().regex(/^[6-9][0-9]{9}$/, 'mobile number 10 ank ka'), image: z.string().max(700_000) }), body);
    const row = await this.db.withShop(shopId, async (tx) => (await tx.query<{
      buyer_name: string; slip_no: number | null; number: string; total_paise: string; paid_paise: string; cash_paise: string; upi_paise: string;
      qty: string; buyer_id: string | null; buyer_phone: string | null; firm: string;
    }>(
      `SELECT b.buyer_name, b.slip_no, b.number, b.total_paise, b.paid_paise, b.cash_paise, b.upi_paise,
              (SELECT COALESCE(SUM(qty), 0) FROM bill_lines l WHERE l.bill_id = b.id) AS qty,
              b.buyer_id, g.phone AS buyer_phone, (SELECT name FROM shops WHERE id = $2) AS firm
       FROM ${LIVE_BILLS} b LEFT JOIN buyers g ON g.id = b.buyer_id WHERE b.id = $1`, [bid, shopId])).rows[0]);
    if (!row) throw new NotFoundException('Yeh parchi nahi mili');
    const total = n(row.total_paise);
    const rs = (p: number) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`;
    const money = total - n(row.paid_paise) > 0 ? 'उधार' : total === 0 ? '-' : n(row.upi_paise) > 0 && n(row.cash_paise) === 0 ? `${rs(total)} UPI` : `${rs(total)} नकद`;
    const p = await this.shared.device(v.phone, shopId);
    await this.slipSends.send(p, 'slip', bid, b.phone, b.image, [row.buyer_name, row.firm || 'Mandi Plus', `${row.slip_no ?? row.number}`, `${n(row.qty)}`, money]);
    if (row.buyer_id && !row.buyer_phone) await this.shared.updateGrahak(v.phone, shopId, row.buyer_id, { phone: b.phone }).catch(() => undefined);
    return { sent: true };
  }

  /** The cheeku desk: dispatch, open gaadis and where they stand, party commission (each party's own %), APMC, mazdoori. */
  @Get('shops/:id/cheeku')
  deskOf(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range, query);
    return this.desk.desk(mine(v, id), r.from, r.to);
  }

  /** The shop's default commission and each party's own %. */
  @Get('shops/:id/cheeku/commissions')
  commissionList(@See() v: Viewer, @Param('id') id: string) {
    return this.commissions.list(mine(v, id));
  }

  /** Sets a party's own commission % (supplier blank = the shop's default); bps null takes it away. */
  @Post('shops/:id/cheeku/commissions')
  setCommission(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(CommissionBody, body);
    return this.commissions.set(mine(v, id), b.supplier, b.bps, v.phone);
  }

  /** The beejaks the shop has made, newest first. */
  @Get('shops/:id/cheeku/beejaks')
  beejaks(@See() v: Viewer, @Param('id') id: string, @Query('q') q?: string) {
    return this.desk.beejaks(mine(v, id), (q ?? '').slice(0, 60));
  }

  @Get('shops/:id/cheeku/beejaks/:bid')
  beejakById(@See() v: Viewer, @Param('id') id: string, @Param('bid') bid: string) {
    return this.desk.beejakById(mine(v, id), parse(z.uuid(), bid));
  }

  /** Makes (or makes again) a gaadi's beejak and keeps it. */
  @Post('shops/:id/cheeku/beejak/:truckId')
  saveBeejak(@See() v: Viewer, @Param('id') id: string, @Param('truckId') truckId: string, @Body() body: unknown) {
    return this.desk.saveBeejak(v.phone, mine(v, id), parse(z.uuid(), truckId), parse(CheekuBeejakBody, body));
  }

  /** A party's beejak for one gaadi: qualities sold, average bhav, gross and bhada. */
  @Get('shops/:id/cheeku/beejak/:truckId')
  beejak(@See() v: Viewer, @Param('id') id: string, @Param('truckId') truckId: string) {
    return this.desk.beejak(mine(v, id), parse(z.uuid(), truckId));
  }

  /** Every supplier for a financial year (April to March): carried opening, beejaks, paid, balance. */
  @Get('shops/:id/cheeku/creditors')
  creditorList(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    return this.creditors.list(mine(v, id), parse(FyQuery, query).fy);
  }

  @Get('shops/:id/cheeku/creditors/:key')
  creditorKhata(@See() v: Viewer, @Param('id') id: string, @Param('key') key: string, @Query() query: unknown) {
    return this.creditors.khata(mine(v, id), key.slice(0, 120), parse(FyQuery, query).fy);
  }

  /** Adds or changes a supplier on the creditors' list (the supplier master is shared plumbing; names in capitals by cheeku's rule). */
  @Post('shops/:id/cheeku/creditors')
  async saveCreditor(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    const shopId = mine(v, id);
    await requireCheeku(this.db, shopId);
    return this.shared.saveSupplier(v.phone, shopId, parse(SupplierBody, body));
  }

  /** Laddan parties with their master fields and balances. */
  @Get('shops/:id/cheeku/laddan')
  laddan(@See() v: Viewer, @Param('id') id: string, @Query('q') q?: string) {
    return this.creditors.laddan(mine(v, id), (q ?? '').slice(0, 60));
  }

  /** All Ledger: every slip sent on with the shop's personal bill, its net, profit or loss, and whether it was scanned. */
  @Get('shops/:id/cheeku/forward-bills')
  forwardBills(@See() v: Viewer, @Param('id') id: string) {
    return this.forward.ledger(mine(v, id));
  }

  /** Saves the personal bill of one slip sent on (never the slip itself). */
  @Post('shops/:id/cheeku/forward-bills/:billId')
  saveForwardBill(@See() v: Viewer, @Param('id') id: string, @Param('billId') billId: string, @Body() body: unknown) {
    return this.forward.saveBill(mine(v, id), parse(z.uuid(), billId), parse(PersonalBillBody, body), v.phone);
  }

  /** "Dobara bhejein": the bill of a slip sent on goes to the grahak on WhatsApp again (its picture must have come from the app). */
  @Post('shops/:id/cheeku/forward-bills/:billId/whatsapp/resend')
  resendForwardWhatsapp(@See() v: Viewer, @Param('id') id: string, @Param('billId') billId: string) {
    return this.forwardSends.resend(mine(v, id), parse(z.uuid(), billId));
  }

  /** Sends boxes off the gaadis to a grahak: the shop's own slip, the stock down, the vehicle noted. */
  @Post('shops/:id/cheeku/forward')
  sendForward(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(ForwardBody, body);
    return this.forward.create(v.phone, mine(v, id), { ...b, staff: b.staff || undefined });
  }

  /** Cancels a slip sent on — refused once any box has been scanned out against it. */
  @Post('shops/:id/cheeku/forward/:billId/cancel')
  cancelForward(@See() v: Viewer, @Param('id') id: string, @Param('billId') billId: string) {
    return this.forward.cancel(v.phone, mine(v, id), parse(z.uuid(), billId));
  }

  /** The slip that goes with the maal: the grahak, the quality and the boxes and the QR's id — never a rate or an amount. */
  @Get('shops/:id/cheeku/forward/:billId/slip')
  forwardSlip(@See() v: Viewer, @Param('id') id: string, @Param('billId') billId: string) {
    return this.forward.slip(mine(v, id), parse(z.uuid(), billId));
  }

  /** A cheeku gaadi changed: number, supplier, place, bhada, and each quality's boxes. */
  @Post('shops/:id/cheeku/gaadi/:truckId')
  editGaadi(@See() v: Viewer, @Param('id') id: string, @Param('truckId') truckId: string, @Body() body: unknown) {
    return this.entries.editGaadi(v.phone, mine(v, id), parse(z.uuid(), truckId), parse(GaadiBody, body));
  }

  /** Dispatch at the gaadi: a slip by its QR (bill id) or number, and boxes handed over against it. */
  @Get('shops/:id/cheeku/pickup')
  pickupSlip(@See() v: Viewer, @Param('id') id: string, @Query('code') code?: string) {
    return this.entries.pickupSlip(mine(v, id), parse(z.string().trim().min(1).max(40), code ?? ''));
  }

  @Post('shops/:id/cheeku/pickup')
  pickup(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.entries.pickup(v.phone, mine(v, id), parse(z.object({ billId: z.uuid(), qty: z.number().int().min(1).max(100000) }), body));
  }

  @Get('shops/:id/cheeku/labour')
  labourHome(@See() v: Viewer, @Param('id') id: string) {
    return this.entries.labourHome(v.phone, mine(v, id));
  }

  /** Broken boxes reported at the gaadi, the requests, and the accountant settling one or turning it down. */
  @Post('shops/:id/cheeku/breakages')
  reportBreakage(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.entries.reportBreakage(v.phone, mine(v, id), parse(z.object({
      billId: z.uuid(), brandId: z.uuid().nullable(), truckId: z.uuid().nullable(), qty: z.number().int().min(1).max(100000), note: z.string().trim().max(200).optional(),
    }), body));
  }

  @Get('shops/:id/cheeku/breakages')
  breakages(@See() v: Viewer, @Param('id') id: string, @Query('status') status?: string) {
    return this.entries.breakages(mine(v, id), status === 'all' ? 'all' : 'pending');
  }

  @Post('shops/:id/cheeku/breakages/:bid/resolve')
  resolveBreakage(@See() v: Viewer, @Param('id') id: string, @Param('bid') bid: string, @Body() body: unknown) {
    return this.entries.resolveBreakage(v.phone, mine(v, id), parse(z.uuid(), bid),
      parse(z.object({ ratePaise: paise, giveBack: z.enum(['cash', 'advance']).optional() }), body));
  }

  @Post('shops/:id/cheeku/breakages/:bid/reject')
  rejectBreakage(@See() v: Viewer, @Param('id') id: string, @Param('bid') bid: string) {
    return this.entries.rejectBreakage(v.phone, mine(v, id), parse(z.uuid(), bid));
  }
}
