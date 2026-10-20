import {
  Body, CanActivate, Controller, Delete, ExecutionContext, ForbiddenException, Get, HttpCode, Injectable, Param, Post, Query, Res,
  UnauthorizedException, UseGuards, createParamDecorator,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { OtpService } from '../auth/otp.service';
import { adminPhones, config } from '../config';
import { parse, phone } from '../common/validate';
import { Db } from '../db/db.service';
import { AdminService } from './admin.service';
import { ReportsService, type Pot } from './reports.service';
import { EntriesService } from './entries.service';
import { SettingsService } from './settings.service';
import { InsightsService } from './insights.service';
import { UdhaarAlertsService } from '../alerts/udhaar-alerts.service';
import { PortalTurnBody, PortalVoiceService } from '../voice/portal-voice.service';
import { RemindersService } from '../alerts/reminders.service';
import { GeminiClient } from '../voice/gemini.client';

const SpeakBody = z.object({ text: z.string().trim().min(1).max(500) });

/** Portal tokens are signed with the app's secret but for their own audience, so neither works as the other. */
const AUDIENCE = 'mandipos-admin';
const TTL_SECONDS = 12 * 60 * 60;

/**
 * Who is looking. MandiPlus admins (ADMIN_PHONES) see every shop and the market; a shop's owner
 * sees only the approved shops they own. Read on every request, so taking someone off a shop or
 * off the admin list locks them out at once — the token only says which phone signed in.
 */
export type Viewer = { phone: string; admin: boolean; shopIds: string[] };
type PortalRequest = Request & { viewer?: Viewer };

async function viewerFor(db: Db, phoneNo: string): Promise<Viewer | null> {
  if (adminPhones().includes(phoneNo)) return { phone: phoneNo, admin: true, shopIds: [] };
  const rows = await db.query<{ id: string }>(
    `SELECT s.id FROM shop_members m JOIN users u ON u.id = m.user_id JOIN shops s ON s.id = m.shop_id
     WHERE u.phone = $1 AND m.role = 'owner' AND s.approved_at IS NOT NULL ORDER BY s.created_at`, [phoneNo]);
  return rows.length ? { phone: phoneNo, admin: false, shopIds: rows.map((r) => r.id) } : null;
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<PortalRequest>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException('Login zaroori hai');
    let phoneNo: string;
    try {
      phoneNo = (jwt.verify(header.slice(7), config().JWT_SECRET, { algorithms: ['HS256'], audience: AUDIENCE }) as { sub: string }).sub;
    } catch {
      throw new UnauthorizedException('Session expire ho gaya');
    }
    const viewer = await viewerFor(this.db, phoneNo);
    if (!viewer) throw new UnauthorizedException('Is number ki koi dukaan nahi');
    req.viewer = viewer;
    return true;
  }
}

const See = createParamDecorator((_: unknown, ctx: ExecutionContext): Viewer => ctx.switchToHttp().getRequest<PortalRequest>().viewer!);

const Id = z.uuid();
const Day = z.iso.date();
const Range = z.object({ from: Day, to: Day });
const Code = z.object({ phone, code: z.string().regex(/^\d{4,8}$/, 'must be the OTP digits') });
const CustomerKey = z.union([z.string().regex(/^[6-9]\d{9}$/), z.string().regex(/^[0-9a-f-]{36}~[0-9a-f-]{36}$/)]);
const RejectBody = z.object({ reason: z.string().trim().max(200).default('') });
const PotQuery = Range.extend({ pot: z.enum(['galla', 'office', 'bank']).default('galla') });
const SupplierKey = z.string().min(1).max(120);

const paise = z.number().int().min(0).max(1_000_000_000_00);
const grade = z.enum(['1', '2', '3', 'mix']);
const DayIso = z.iso.date().optional();
const ParchiBody = z.object({
  buyerId: z.uuid().optional(), buyerName: z.string().trim().max(120).optional(), truckId: z.uuid(),
  lines: z.array(z.object({ grade, qty: z.number().int().min(0).max(10_000_000), ratePaise: paise })).min(1).max(20),
  pay: z.enum(['cash', 'upi', 'credit', 'after', 'split', 'free']), cashPaise: paise.optional(), upiPaise: paise.optional(),
  upiBank: z.string().max(80).optional(),
  packing: z.enum(['loose', 'katta10', 'katta15', 'katta20', 'katta25', 'panni']).default('loose'), panniName: z.string().max(40).optional(),
  kattaName: z.string().max(20).optional(), parchune: z.boolean().optional(),
  labour: z.boolean().optional(), labourQty: z.number().int().min(0).max(100_000).optional(), labourRatePaise: z.number().int().min(0).max(10_000).optional(),
  delivery: z.object({ address: z.string().max(200), stand: z.string().max(120) }).optional(),
  staff: z.string().max(60).optional(), slipNo: z.number().int().positive().max(9_999_999).optional(),
});
const mobileOrBlank = z.union([z.literal(''), phone]);
const SettingsBody = z.object({
  name: z.string().trim().min(1).max(120), mandi: z.string().trim().max(80), shopNo: z.string().trim().max(20),
  phad: z.string().trim().max(40), gstin: z.string().trim().toUpperCase().max(15),
  phone: mobileOrBlank, dispatchPhone: mobileOrBlank,
  slipCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9&]{0,6}$/, 'up to 6 letters or digits'),
  slipLimitPaise: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), udhaarRates: z.boolean(), udhaarAlerts: z.boolean(),
  address: z.string().trim().max(200),
  bankAccounts: z.array(z.object({
    holder: z.string().trim().max(80).default(''), bank: z.string().trim().max(80).default(''),
    ifsc: z.string().trim().toUpperCase().max(11).default(''), account: z.string().trim().max(34).default(''),
  })).max(4),
  printerHost: z.string().trim().regex(/^(\d{1,3}(\.\d{1,3}){3})?$/, 'an IP like 192.168.1.50'),
  printerDots: z.union([z.literal(384), z.literal(576), z.literal(832)]),
}).partial();
const BhavBody = z.object({ date: DayIso, rates: z.array(z.object({ brandId: z.uuid(), grade: z.enum(['1', '2', '3']), ratePaise: paise })).min(1).max(300) });
const VoidBody = z.object({ reason: z.enum(['deleted', 'refunded', 'advance']).default('deleted') });
const VasooliBody = z.object({ buyerId: z.uuid(), cashPaise: paise, upiPaise: paise, upiBank: z.string().max(80).optional(), paymentRef: z.string().max(40).optional() });
const OUT_HEADS = ['kharcha', 'mazdoori', 'bhada', 'kiraya', 'tankhwah', 'committee_di', 'bill', 'udhaar_diya', 'aur_gaya', 'handover', 'float', 'bank_jama', 'bank_nikala'] as const;
const IN_HEADS = ['udhaar_wapas', 'committee_mili', 'aur_aaya'] as const;
const DaybookBody = z.object({
  direction: z.enum(['in', 'out']), category: z.enum([...OUT_HEADS, ...IN_HEADS]), mode: z.enum(['cash', 'office', 'upi', 'bank']),
  amountPaise: paise.positive(), party: z.string().max(120).optional(), note: z.string().max(200).optional(), date: DayIso,
}).refine((b) => (b.direction === 'out' ? (OUT_HEADS as readonly string[]) : (IN_HEADS as readonly string[])).includes(b.category), { message: 'yeh head is taraf ka nahi', path: ['category'] });
const UdhaarBody = z.object({ buyerId: z.uuid(), amountPaise: z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00).refine((v) => v !== 0, 'zero'), note: z.string().max(200).optional(), date: DayIso });
const GrahakBody = z.object({
  name: z.string().trim().min(1).max(120), phone: z.string().trim().max(15).optional(), address: z.string().max(200).optional(),
  destination: z.string().max(120).optional(), code: z.string().max(20).optional(), vehicle: z.string().max(20).optional(),
  openingPaise: z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00).optional(),
});
const GaadiBody = z.object({
  number: z.string().trim().min(1).max(20), supplier: z.string().trim().max(120).default(''), freightPaise: paise.optional(),
  lots: z.array(z.object({ brandId: z.uuid().optional(), brandName: z.string().trim().max(60).optional(), grade, qty: z.number().int().min(0).max(10_000_000), ratePaise: paise })).min(1).max(12),
});
const SupplierPayBody = z.object({ supplier: z.string().trim().min(1).max(120), mode: z.enum(['cash', 'office', 'upi', 'bank']), amountPaise: paise.positive(), note: z.string().max(200).optional(), date: DayIso });

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** Sign-in: OTP to a MandiPlus admin number, or to the owner of an approved shop. */
@Controller('v1/admin/auth')
export class AdminAuthController {
  constructor(private readonly otp: OtpService, private readonly db: Db) {}

  @Post('otp')
  @HttpCode(204)
  async sendOtp(@Body() body: unknown) {
    const p = parse(z.object({ phone }), body).phone;
    await this.allowed(p);
    await this.otp.send(p);
  }

  @Post('verify')
  @HttpCode(200)
  async verify(@Body() body: unknown) {
    const b = parse(Code, body);
    await this.allowed(b.phone);
    await this.otp.verify(b.phone, b.code);
    const token = jwt.sign({ sub: b.phone }, config().JWT_SECRET, { algorithm: 'HS256', audience: AUDIENCE, expiresIn: TTL_SECONDS });
    return { token, phone: b.phone, expiresIn: TTL_SECONDS };
  }

  /**
   * A number that is neither an admin nor a shop owner is refused before any SMS goes out. A
   * number on OTP_TEST_LOGINS signs in with its fixed code, as it does in the app (Omi's call for
   * 9010101010, 2026-10-15).
   */
  private async allowed(p: string) {
    if (!(await viewerFor(this.db, p))) throw new ForbiddenException('Is number ki koi dukaan nahi');
  }
}

@Controller('v1/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService, private readonly reports: ReportsService, private readonly entries: EntriesService,
    private readonly settings: SettingsService, private readonly insights: InsightsService, private readonly voice: PortalVoiceService, private readonly gemini: GeminiClient,
    private readonly alerts: UdhaarAlertsService, private readonly reminders: RemindersService,
  ) {}

  // ---------------------------------------------------------------- Bolo (voice), as on the terminal

  /** The mic opened: read the shop's books now, so the turn does not wait on them. */
  @Post('shops/:id/voice/warm')
  @HttpCode(200)
  voiceWarm(@See() v: Viewer, @Param('id') id: string) {
    return this.voice.warm(v.phone, mine(v, id));
  }

  /**
   * The answer read out, for any browser: 16-bit mono PCM at 24 kHz, streamed as it is made
   * (the page plays it through Web Audio). no-transform keeps compression from holding it back.
   */
  @Post('shops/:id/voice/speak')
  async voiceSpeak(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    mine(v, id);
    const { text } = parse(SpeakBody, body);
    const ctl = new AbortController();
    res.on('close', () => ctl.abort());
    let started = false;
    try {
      for await (const pcm of this.gemini.speak(text, ctl.signal)) {
        if (!started) { res.status(200).set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store, no-transform' }); started = true; }
        res.write(pcm);
      }
      if (!started) res.status(502);
      res.end();
    } catch (e) {
      if (!started) res.status(502).json({ message: (e as Error).message.slice(0, 120) });
      else res.end();
    }
  }

  /** One recording in; a draft for the entry form, or the answer's figures, out. Nothing is saved. */
  @Post('shops/:id/voice')
  @HttpCode(200)
  async voiceTurn(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    const shopId = mine(v, id);
    // The other shops this person may open: "Om AL Shamsh mein hai" instead of "nahi mila".
    const shops = v.admin ? (await this.admin.shops()).filter((x) => x.status === 'approved').map((x) => x.id) : v.shopIds;
    return this.voice.turn(v.phone, shopId, parse(PortalTurnBody, body), shops);
  }

  /** Who is signed in, and which shops they may open. */
  @Get('me')
  me(@See() v: Viewer) {
    return { phone: v.phone, admin: v.admin, shopIds: v.admin ? null : v.shopIds };
  }

  /** Admin: every shop, requests first. Owner: their own shops. */
  @Get('shops')
  async shops(@See() v: Viewer) {
    const all = await this.admin.shops();
    return { shops: v.admin ? all : all.filter((s) => v.shopIds.includes(s.id)) };
  }

  @Get('shops/:id')
  shop(@See() v: Viewer, @Param('id') id: string) {
    return this.admin.shop(mine(v, id));
  }

  @Post('shops/:id/approve')
  @HttpCode(204)
  async approve(@See() v: Viewer, @Param('id') id: string) {
    adminOnly(v);
    await this.admin.approve(parse(Id, id), v.phone);
  }

  @Post('shops/:id/reject')
  @HttpCode(204)
  async reject(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    adminOnly(v);
    await this.admin.reject(parse(Id, id), v.phone, parse(RejectBody, body ?? {}).reason);
  }

  /** The app's Home/Hisab figures for business dates [from, to]. */
  @Get('shops/:id/summary')
  summary(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range, query);
    return this.admin.summary(mine(v, id), r.from, r.to);
  }

  /** Admin only: grahak across every shop, matched by mobile — one shop never sees another's books. */
  @Get('customers')
  async customers(@See() v: Viewer, @Query('q') q?: string) {
    adminOnly(v);
    const query = (q ?? '').trim().slice(0, 60);
    return { customers: await this.admin.customers(query), market: query ? null : await this.admin.marketDues() };
  }

  @Get('customers/:key')
  customer(@See() v: Viewer, @Param('key') key: string) {
    adminOnly(v);
    return this.admin.customer(parse(CustomerKey, key));
  }

  /** Every slip, payment and daybook line of business dates [from, to]. */
  @Get('shops/:id/daybook')
  daybook(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range, query);
    return this.admin.daybook(mine(v, id), r.from, r.to);
  }

  /** Tally's columnar Sales Register: a line per day. */
  @Get('shops/:id/sales-register')
  salesRegister(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range, query);
    return this.insights.salesRegister(mine(v, id), r.from, r.to);
  }

  /** Each gaadi's landed cost against its sales: its munafa. */
  @Get('shops/:id/gaadi-hisab')
  gaadiHisab(@See() v: Viewer, @Param('id') id: string, @Query('view') view?: string) {
    return this.insights.gaadiHisab(mine(v, id), view === 'past' ? 'past' : 'active');
  }

  /** The period's profit and loss. */
  @Get('shops/:id/munafa')
  munafa(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range, query);
    return this.insights.munafa(mine(v, id), r.from, r.to);
  }

  /** Tally's exception reports: what an owner should look at. */
  @Get('shops/:id/nigrani')
  nigrani(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range, query);
    return this.insights.nigrani(mine(v, id), r.from, r.to);
  }

  /** Aaj ka bhav: the rate sheet for a day, and setting it as a terminal does. */
  @Get('shops/:id/bhav')
  bhav(@See() v: Viewer, @Param('id') id: string, @Query('date') date?: string) {
    return this.entries.bhav(mine(v, id), date ? parse(z.iso.date(), date) : undefined);
  }

  @Post('shops/:id/bhav')
  @HttpCode(200)
  setBhav(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.entries.setBhav(v.phone, mine(v, id), parse(BhavBody, body));
  }

  /** The shop's settings, as the app's Settings screen shows them. */
  @Get('shops/:id/settings')
  getSettings(@See() v: Viewer, @Param('id') id: string) {
    return this.settings.get(mine(v, id));
  }

  @Post('shops/:id/settings')
  @HttpCode(200)
  saveSettings(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.settings.save(mine(v, id), parse(SettingsBody, body));
  }

  /** The grahak's udhaar as the bot would send it on WhatsApp, and when it last went. */
  @Get('shops/:id/buyers/:buyerId/whatsapp')
  whatsappDraft(@See() v: Viewer, @Param('id') id: string, @Param('buyerId') buyerId: string) {
    return this.alerts.draft(mine(v, id), parse(Id, buyerId));
  }

  /** The khata PDF that goes with it, to look at before sending. */
  @Get('shops/:id/buyers/:buyerId/whatsapp/pdf')
  async whatsappPdf(@See() v: Viewer, @Param('id') id: string, @Param('buyerId') buyerId: string, @Res() res: Response) {
    const pdf = await this.alerts.khataPdf(mine(v, id), parse(Id, buyerId));
    res.status(200).set({ 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length), 'Cache-Control': 'no-store' }).end(pdf);
  }

  /** Send it now, from the MandiPlus bot's number. */
  @Post('shops/:id/buyers/:buyerId/whatsapp')
  @HttpCode(200)
  whatsappSend(@See() v: Viewer, @Param('id') id: string, @Param('buyerId') buyerId: string) {
    return this.alerts.sendNow(mine(v, id), parse(Id, buyerId), v.phone);
  }

  /** Reminders set by voice that are still to go, soonest first. */
  @Get('shops/:id/reminders')
  async reminderList(@See() v: Viewer, @Param('id') id: string) {
    return { reminders: await this.reminders.upcoming(mine(v, id)) };
  }

  /** Cancel one before it goes. */
  @Delete('shops/:id/reminders/:rid')
  @HttpCode(204)
  async reminderCancel(@See() v: Viewer, @Param('id') id: string, @Param('rid') rid: string) {
    await this.reminders.cancel(mine(v, id), parse(Id, rid));
  }

  /** One parchi in full, as Tally opens a voucher. */
  @Get('shops/:id/bills/:billId')
  bill(@See() v: Viewer, @Param('id') id: string, @Param('billId') billId: string) {
    return this.admin.bill(mine(v, id), parse(Id, billId));
  }

  @Get('shops/:id/buyers')
  async buyers(@See() v: Viewer, @Param('id') id: string, @Query('q') q?: string) {
    return { buyers: await this.admin.buyers(mine(v, id), (q ?? '').trim().slice(0, 60)) };
  }

  @Get('shops/:id/buyers/:buyerId')
  buyer(@See() v: Viewer, @Param('id') id: string, @Param('buyerId') buyerId: string) {
    return this.admin.buyer(mine(v, id), parse(Id, buyerId));
  }

  // ---------------------------------------------------------------- Tally's reports

  @Get('shops/:id/dashboard')
  dashboard(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range, query);
    return this.reports.dashboard(mine(v, id), r.from, r.to, todayIst());
  }

  /** Cash / Bank Book: galla, office or bank, b/f to c/f. */
  @Get('shops/:id/cashbook')
  cashbook(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(PotQuery, query);
    return this.reports.cashbook(mine(v, id), r.pot as Pot, r.from, r.to);
  }

  @Get('shops/:id/outstanding')
  outstanding(@See() v: Viewer, @Param('id') id: string) {
    return this.reports.outstanding(mine(v, id), todayIst());
  }

  @Get('shops/:id/suppliers')
  suppliers(@See() v: Viewer, @Param('id') id: string) {
    return this.reports.suppliers(mine(v, id), todayIst());
  }

  @Get('shops/:id/suppliers/:key')
  supplier(@See() v: Viewer, @Param('id') id: string, @Param('key') key: string) {
    return this.reports.supplier(mine(v, id), parse(SupplierKey, key));
  }

  @Get('shops/:id/stock')
  stock(@See() v: Viewer, @Param('id') id: string, @Query('view') view?: string) {
    return this.reports.stock(mine(v, id), todayIst(), view === 'past' ? 'past' : 'active');
  }

  // ---------------------------------------------------------------- entries, as a terminal makes them

  /** What the entry forms offer: open gaadis, today's bhav, maal, suppliers, bank accounts. */
  @Get('shops/:id/entry-options')
  entryOptions(@See() v: Viewer, @Param('id') id: string) {
    return this.entries.options(mine(v, id));
  }

  @Post('shops/:id/entries/parchi')
  parchi(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.entries.parchi(v.phone, mine(v, id), parse(ParchiBody, body));
  }

  @Post('shops/:id/entries/vasooli')
  vasooli(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.entries.vasooli(v.phone, mine(v, id), parse(VasooliBody, body));
  }

  @Post('shops/:id/entries/daybook')
  daybookEntry(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.entries.daybook(v.phone, mine(v, id), parse(DaybookBody, body));
  }

  @Post('shops/:id/entries/udhaar')
  udhaar(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.entries.udhaar(v.phone, mine(v, id), parse(UdhaarBody, body));
  }

  @Post('shops/:id/entries/grahak')
  grahak(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.entries.grahak(v.phone, mine(v, id), parse(GrahakBody, body));
  }

  @Post('shops/:id/entries/gaadi')
  gaadi(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.entries.gaadi(v.phone, mine(v, id), parse(GaadiBody, body));
  }

  @Post('shops/:id/entries/supplier-payment')
  supplierPayment(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.entries.supplierPayment(v.phone, mine(v, id), parse(SupplierPayBody, body));
  }

  // ---------------------------------------------------------------- Badlein / Hatayein, as the app's slip and raseed screens

  /** Hatayein: a slip with money on it must say what happens to the money (refunded or advance). */
  @Post('shops/:id/bills/:billId/void')
  @HttpCode(200)
  voidBill(@See() v: Viewer, @Param('id') id: string, @Param('billId') billId: string, @Body() body: unknown) {
    return this.entries.voidBill(v.phone, mine(v, id), parse(Id, billId), parse(VoidBody, body ?? {}).reason);
  }

  /** Badlein: the corrected slip, as Nayi Parchi takes it; it keeps the slip's number. */
  @Post('shops/:id/bills/:billId/edit')
  editBill(@See() v: Viewer, @Param('id') id: string, @Param('billId') billId: string, @Body() body: unknown) {
    return this.entries.editParchi(v.phone, mine(v, id), parse(Id, billId), parse(ParchiBody, body));
  }

  /** One raseed in full: every row of the payment, and the slips it paid. */
  @Get('shops/:id/collections/:cid')
  collection(@See() v: Viewer, @Param('id') id: string, @Param('cid') cid: string) {
    return this.entries.collection(mine(v, id), parse(Id, cid));
  }

  @Post('shops/:id/collections/:cid/void')
  @HttpCode(200)
  voidCollection(@See() v: Viewer, @Param('id') id: string, @Param('cid') cid: string) {
    return this.entries.voidCollection(v.phone, mine(v, id), parse(Id, cid));
  }

  @Post('shops/:id/collections/:cid/edit')
  editCollection(@See() v: Viewer, @Param('id') id: string, @Param('cid') cid: string, @Body() body: unknown) {
    return this.entries.editCollection(v.phone, mine(v, id), parse(Id, cid), parse(VasooliBody.omit({ buyerId: true }), body));
  }

  @Get('shops/:id/items')
  items(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range, query);
    return this.reports.items(mine(v, id), r.from, r.to);
  }
}

/** The shop id, if this viewer may open it; anything else is refused. */
function mine(v: Viewer, id: string): string {
  const shopId = parse(Id, id);
  if (!v.admin && !v.shopIds.includes(shopId)) throw new ForbiddenException('Yeh aapki dukaan nahi');
  return shopId;
}

function adminOnly(v: Viewer) {
  if (!v.admin) throw new ForbiddenException('Yeh sirf MandiPlus admin dekh sakte hain');
}
