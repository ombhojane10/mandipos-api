import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, Me } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse } from '../common/validate';
import { cheekuShopOf } from './cheeku';
import { CheekuCommissionsService } from './cheeku-commissions.service';
import { CheekuCreditorsService } from './cheeku-creditors.service';
import { CheekuForwardSendsService } from './cheeku-forward-sends.service';
import { CheekuForwardService } from './cheeku-forward.service';
import { CHEEKU_BEEJAK_HEADS, CheekuDeskService } from './cheeku-desk.service';
import { CheekuSettingsService } from './cheeku-settings.service';
import { CheekuSlipSendsService } from './cheeku-slip-sends.service';

const paise = z.number().int().min(0).max(1_000_000_000_00);
/** The beejak body, as the grapes one (admin BeejakBody) — its own copy. */
const CheekuBeejakBody = z.object({
  day: z.iso.date().optional(),
  bhav: z.array(z.object({ quality: z.string().max(60), ratePaise: paise })).max(50),
  heads: z.array(z.object({ key: z.enum(CHEEKU_BEEJAK_HEADS.map((h) => h.key) as [string, ...string[]]), rate: z.number().int().min(0).max(10_000_000).optional(), amountPaise: paise.optional() })).max(20),
});
const AppBeejakBody = CheekuBeejakBody.extend({ by: z.string().trim().max(60).default('') });
/** A party's commission: % in basis points (6% = 600, at most 50%); null = back to the default. */
const CommissionBody = z.object({ supplier: z.string().trim().max(120).default(''), bps: z.number().int().min(0).max(5000).nullable(), by: z.string().trim().max(60).default('') });
/** The shop's personal bill for a slip sent on: its own rate per quality (by brand id), bhada, mazdoori, commission. */
const PersonalBillBody = z.object({
  rates: z.record(z.uuid(), paise).default({}), bhadaPaise: paise, mazdooriPaise: paise, commissionPaise: paise,
  by: z.string().trim().max(60).default(''),
});
const Fy = z.coerce.number().int().min(2000).max(2100);
const SendBody = z.object({
  id: z.uuid(),
  phone: z.string().trim().regex(/^[6-9][0-9]{9}$/, 'a 10-digit mobile number'),
  image: z.string().min(8).max(600_000),
  params: z.array(z.string().max(200)).min(1).max(6),
});

/**
 * Cheeku, for the terminals: its own copies of the grapes app endpoints — the beejak
 * (/v1/beejaks), supplier creditors, slip and beejak on WhatsApp (/v1/whatsapp) and the shop's
 * switches (/v1/shops/apmc, slip-whatsapp, staff-backup-code). Same bodies and answers as the
 * grapes ones; a shop that isn't cheeku is refused (422).
 */
@Controller('v1/cheeku')
@UseGuards(AuthGuard)
export class CheekuAppController {
  constructor(
    private readonly desk: CheekuDeskService, private readonly creditors: CheekuCreditorsService,
    private readonly sends: CheekuSlipSendsService, private readonly settings: CheekuSettingsService,
    private readonly commissions: CheekuCommissionsService, private readonly forward: CheekuForwardService,
    private readonly forwardSends: CheekuForwardSendsService,
  ) {}

  /** The shop's default commission and each party's own %. */
  @Get('commissions')
  commissionList(@Me() p: Principal) {
    return this.commissions.list(cheekuShopOf(p));
  }

  /** Sets a party's own commission % (supplier blank = the shop's default); bps null takes it away. */
  @Post('commissions')
  @HttpCode(200)
  setCommission(@Me() p: Principal, @Body() body: unknown) {
    const b = parse(CommissionBody, body);
    return this.commissions.set(cheekuShopOf(p), b.supplier, b.bps, b.by || 'App');
  }

  /** All Ledger: every slip sent on with the shop's personal bill, its net and its profit or loss. */
  @Get('forward-bills')
  forwardBills(@Me() p: Principal) {
    return this.forward.ledger(cheekuShopOf(p));
  }

  /** Saves the personal bill of one slip sent on (never the slip itself). */
  @Post('forward-bills/:billId')
  @HttpCode(200)
  saveForwardBill(@Me() p: Principal, @Param('billId') billId: string, @Body() body: unknown) {
    const b = parse(PersonalBillBody, body);
    return this.forward.saveBill(cheekuShopOf(p), parse(z.uuid(), billId), b, b.by || 'App');
  }

  /**
   * Keeps the picture of the party's slip and the grahak's mobile; the server sends it on the first scan, from any
   * device, and tries again until WhatsApp takes it.
   */
  @Post('forward-bills/:billId/whatsapp')
  @HttpCode(200)
  queueForwardWhatsapp(@Me() p: Principal, @Param('billId') billId: string, @Body() body: unknown) {
    const b = parse(z.object({
      phone: z.string().trim().regex(/^[6-9][0-9]{9}$/, 'a 10-digit mobile number'),
      image: z.string().min(8).max(600_000), params: z.array(z.string().max(200)).min(1).max(6),
    }), body);
    return this.forwardSends.queue(cheekuShopOf(p), parse(z.uuid(), billId), b.phone, b.image, b.params);
  }

  /**
   * Any slip (not only one sent on): its picture and the grahak's mobile, kept until the QR is scanned — then the
   * server sends it on WhatsApp and an SMS with the bill link, from whichever device scanned.
   */
  @Post('slips/:billId/on-scan')
  @HttpCode(200)
  queueSlipOnScan(@Me() p: Principal, @Param('billId') billId: string, @Body() body: unknown) {
    const b = parse(z.object({
      phone: z.string().trim().regex(/^[6-9][0-9]{9}$/, 'a 10-digit mobile number'),
      image: z.string().min(8).max(600_000), params: z.array(z.string().max(200)).min(1).max(6),
    }), body);
    return this.forwardSends.queue(cheekuShopOf(p), parse(z.uuid(), billId), b.phone, b.image, b.params, false);
  }

  /** "Dobara bhejein": the bill goes again now. */
  @Post('forward-bills/:billId/whatsapp/resend')
  @HttpCode(200)
  resendForwardWhatsapp(@Me() p: Principal, @Param('billId') billId: string) {
    return this.forwardSends.resend(cheekuShopOf(p), parse(z.uuid(), billId));
  }

  @Get('beejaks/:truckId')
  beejak(@Me() p: Principal, @Param('truckId') truckId: string) {
    return this.desk.beejak(cheekuShopOf(p), parse(z.uuid(), truckId));
  }

  /** Supplier creditors for the app (read here; the master syncs as supplier_phones). */
  @Get('beejaks/creditors/list')
  creditorList(@Me() p: Principal, @Query('fy') fy?: string) {
    return this.creditors.list(cheekuShopOf(p), fy ? parse(Fy, fy) : undefined);
  }

  @Get('beejaks/creditors/:key')
  creditor(@Me() p: Principal, @Param('key') key: string, @Query('fy') fy?: string) {
    return this.creditors.khata(cheekuShopOf(p), key.slice(0, 120), fy ? parse(Fy, fy) : undefined);
  }

  @Post('beejaks/:truckId')
  saveBeejak(@Me() p: Principal, @Param('truckId') truckId: string, @Body() body: unknown) {
    const b = parse(AppBeejakBody, body);
    return this.desk.saveBeejak(b.by || 'App', cheekuShopOf(p), parse(z.uuid(), truckId), b);
  }

  @Post('whatsapp/slip')
  @HttpCode(200)
  whatsappSlip(@Me() p: Principal, @Body() body: unknown) {
    const b = parse(SendBody, body);
    return this.sends.send(p, 'slip', b.id, b.phone, b.image, b.params);
  }

  @Post('whatsapp/beejak')
  @HttpCode(200)
  whatsappBeejak(@Me() p: Principal, @Body() body: unknown) {
    const b = parse(SendBody, body);
    return this.sends.send(p, 'beejak', b.id, b.phone, b.image, b.params);
  }

  /** Admin: APMC on new slips, on or off. */
  @Post('shops/apmc')
  @HttpCode(204)
  async apmc(@Me() p: Principal, @Body() body: unknown) {
    await this.settings.setApmc(p, parse(z.object({ on: z.boolean() }), body).on);
  }

  /** Admin: send each slip to the grahak on WhatsApp as it is saved. */
  @Post('shops/slip-whatsapp')
  @HttpCode(204)
  async slipWhatsapp(@Me() p: Principal, @Body() body: unknown) {
    await this.settings.setSlipWhatsapp(p, parse(z.object({ on: z.boolean() }), body).on);
  }

  /** Admin: the backup code for the accountant lock. */
  @Post('shops/staff-backup-code')
  @HttpCode(204)
  async staffBackupCode(@Me() p: Principal, @Body() body: unknown) {
    await this.settings.setStaffBackupCode(p, parse(z.object({ code: z.string().trim().regex(/^[0-9]{2,8}$/, '2 to 8 digits') }), body).code);
  }
}

export { CheekuBeejakBody };
