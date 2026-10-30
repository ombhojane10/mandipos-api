import {
  BadRequestException, Body, CanActivate, Controller, Delete, ExecutionContext, ForbiddenException, Get, HttpCode, Injectable, Param, Post, Query, Res,
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
import { BEEJAK_HEADS, InsightsService } from './insights.service';
import { CreditorsService } from './creditors.service';
import { MachinesService } from './machines.service';
import { DepositsService, NOTES } from './deposits.service';
import { MastersService } from './masters.service';
import { CratesService } from './crates.service';
import { ColdStoreService } from './cold-store.service';
import { BooksService } from './books.service';
import { CN_REASONS, VouchersService } from './vouchers.service';
import { GSTIN, InvoicesService } from './invoices.service';
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
export type Viewer = { phone: string; admin: boolean; shopIds: string[]; labourShopIds: string[] };
type PortalRequest = Request & { viewer?: Viewer };

async function viewerFor(db: Db, phoneNo: string): Promise<Viewer | null> {
  if (adminPhones().includes(phoneNo)) return { phone: phoneNo, admin: true, shopIds: [], labourShopIds: [] };
  const rows = await db.query<{ id: string; role: string }>(
    `SELECT s.id, m.role FROM shop_members m JOIN users u ON u.id = m.user_id JOIN shops s ON s.id = m.shop_id
     WHERE u.phone = $1 AND m.role IN ('owner', 'labour') AND s.approved_at IS NOT NULL ORDER BY s.created_at`, [phoneNo]);
  return rows.length
    ? { phone: phoneNo, admin: false, shopIds: rows.map((r) => r.id), labourShopIds: rows.filter((r) => r.role === 'labour').map((r) => r.id) }
    : null;
}

/** All a labour login may do on the website, as in the app: scan slips, hand boxes over, report broken ones. */
const LABOUR_HANDLERS = new Set(['me', 'shops', 'pickupSlip', 'pickup', 'reportBreakage', 'labourHome']);

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
    // A labour login, on its labour shop (or anywhere, when that is all it has), gets the scanner alone.
    const shopId = (req.params as Record<string, string> | undefined)?.id;
    const labour = !viewer.admin && (shopId ? viewer.labourShopIds.includes(shopId) : viewer.labourShopIds.length === viewer.shopIds.length);
    if (labour && !LABOUR_HANDLERS.has(ctx.getHandler().name)) throw new ForbiddenException('Labour login sirf scan kar sakta hai');
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
  buyerId: z.uuid().optional(), buyerName: z.string().trim().max(120).optional(), truckId: z.uuid().optional(),
  lines: z.array(z.object({ grade, qty: z.number().int().min(0).max(10_000_000), ratePaise: paise })).min(1).max(20).optional(),
  // Angoor: each line one quality off one gaadi.
  lots: z.array(z.object({ truckId: z.uuid(), brandId: z.uuid(), qty: z.number().int().min(0).max(10_000_000), ratePaise: paise })).min(1).max(20).optional(),
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
    branch: z.string().trim().max(80).default(''), phone: z.string().trim().max(15).default(''), pan: z.string().trim().toUpperCase().max(10).default(''),
  })).max(4),
  printerHost: z.string().trim().regex(/^(\d{1,3}(\.\d{1,3}){3})?$/, 'an IP like 192.168.1.50'),
  printerDots: z.union([z.literal(384), z.literal(576), z.literal(832)]),
  licenceNo: z.string().trim().toUpperCase().max(40), companyCode: z.string().trim().toUpperCase().max(20),
  contactPerson: z.string().trim().max(80), email: z.union([z.literal(''), z.email().max(120)]),
}).partial();
const BhavBody = z.object({ date: DayIso, rates: z.array(z.object({ brandId: z.uuid(), grade: z.enum(['1', '2', '3']), ratePaise: paise })).min(1).max(300) });
const VoidBody = z.object({ reason: z.enum(['deleted', 'refunded', 'advance']).default('deleted') });
const VasooliBody = z.object({ buyerId: z.uuid(), cashPaise: paise, upiPaise: paise, upiBank: z.string().max(80).optional(), paymentRef: z.string().max(40).optional() });
const OUT_HEADS = ['kharcha', 'mazdoori', 'bhada', 'kiraya', 'tankhwah', 'committee_di', 'bill', 'udhaar_diya', 'aur_gaya', 'handover', 'float', 'bank_jama', 'bank_nikala'] as const;
const IN_HEADS = ['udhaar_wapas', 'committee_mili', 'aur_aaya'] as const;
const DaybookBody = z.object({
  direction: z.enum(['in', 'out']), category: z.enum([...OUT_HEADS, ...IN_HEADS]), mode: z.enum(['cash', 'office', 'upi', 'bank']),
  amountPaise: paise.positive(), party: z.string().max(120).optional(), note: z.string().max(200).optional(), date: DayIso,
  // A head from the General Ledger master: written as its nearest category, the head's name as party.
  headId: z.uuid().optional(),
}).refine((b) => (b.direction === 'out' ? (OUT_HEADS as readonly string[]) : (IN_HEADS as readonly string[])).includes(b.category), { message: 'yeh head is taraf ka nahi', path: ['category'] });
const UdhaarBody = z.object({ buyerId: z.uuid(), amountPaise: z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00).refine((v) => v !== 0, 'zero'), note: z.string().max(200).optional(), date: DayIso });
const LaddanCols = {
  city: z.string().max(60).optional(), district: z.string().max(60).optional(), state: z.string().max(60).optional(),
  contactPerson: z.string().max(80).optional(), email: z.string().max(120).optional(), area: z.string().max(60).optional(),
  bankDetails: z.string().max(300).optional(),
};
const GrahakBody = z.object({
  name: z.string().trim().min(1).max(120), phone: z.string().trim().max(15).optional(), address: z.string().max(200).optional(),
  destination: z.string().max(120).optional(), code: z.string().max(20).optional(), vehicle: z.string().max(20).optional(),
  openingPaise: z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00).optional(),
  kind: z.enum(['', 'laddan']).optional(), ...LaddanCols,
});
const GrahakPatchBody = z.object({
  name: z.string().trim().min(1).max(120).optional(), phone: z.string().trim().max(15).optional(), address: z.string().max(200).optional(),
  destination: z.string().max(120).optional(), code: z.string().max(20).optional(), kind: z.enum(['', 'laddan']).optional(), hidden: z.boolean().optional(), ...LaddanCols,
  // Website only (for tax invoices): kept beside the grahak, never synced.
  gstin: z.string().trim().toUpperCase().max(15).optional(),
});
const SupplierBody = z.object({
  id: z.uuid().optional(), name: z.string().trim().min(1).max(120), code: z.string().max(20).optional(), area: z.string().max(60).optional(),
  phone: z.string().trim().max(15).optional(), openingPaise: z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00).optional(),
  openingOn: z.iso.date().nullable().optional(),
});
const FyQuery = z.object({ fy: z.coerce.number().int().min(2000).max(2100).optional() });
const GaadiBody = z.object({
  number: z.string().trim().min(1).max(20), supplier: z.string().trim().max(120).default(''), freightPaise: paise.optional(),
  location: z.string().trim().max(80).optional(),
  lots: z.array(z.object({ brandId: z.uuid().optional(), brandName: z.string().trim().max(60).optional(), grade, qty: z.number().int().min(0).max(10_000_000), ratePaise: paise,
    boxGrams: z.number().int().min(0).max(1_000_000).optional() })).min(1).max(12),
});
export const BeejakBody = z.object({
  day: z.iso.date().optional(),
  bhav: z.array(z.object({ quality: z.string().max(60), ratePaise: paise })).max(50),
  heads: z.array(z.object({ key: z.enum(BEEJAK_HEADS.map((h) => h.key) as [string, ...string[]]), rate: z.number().int().min(0).max(10_000_000).optional(), amountPaise: paise.optional() })).max(20),
});
const SupplierPayBody = z.object({ supplier: z.string().trim().min(1).max(120), mode: z.enum(['cash', 'office', 'upi', 'bank']), amountPaise: paise.positive(), note: z.string().max(200).optional(), date: DayIso });

const MachineBody = z.object({
  serial: z.string().trim().min(3).max(40), model: z.string().trim().max(40).optional(), tid: z.string().trim().max(40).optional(), note: z.string().trim().max(200).optional(),
});
const GiveBody = z.object({
  shopId: z.uuid().nullable().default(null), name: z.string().trim().max(80).default(''), phone: mobileOrBlank.default(''),
  onDay: DayIso, deviceId: z.uuid().nullable().optional(), note: z.string().trim().max(200).optional(),
});
const BackBody = z.object({ status: z.enum(['stock', 'repair', 'lost']), onDay: DayIso, note: z.string().trim().max(200).optional() });
const LinkBody = z.object({ deviceId: z.uuid().nullable() });

const DepositAccountBody = z.object({
  holder: z.string().trim().max(120).default(''), bank: z.string().trim().max(80).default(''), branch: z.string().trim().max(80).default(''),
  ifsc: z.string().trim().max(11).default(''), account: z.string().trim().min(4, 'Account number daalein').max(34),
  phone: z.string().trim().max(15).default(''), pan: z.string().trim().max(10).default(''),
});
const DepositBody = z.object({
  day: DayIso, account: DepositAccountBody, note: z.string().max(200).optional(), daybook: z.boolean().optional(), saveAccount: z.boolean().optional(),
  notes: z.object(Object.fromEntries(NOTES.map((k) => [k, z.number().int().min(0).max(k === 'coins' ? 1_000_000_00 : 100_000).optional()]))).default({}),
  cheques: z.array(z.object({
    id: z.uuid().optional(), buyerId: z.uuid().nullable().optional(), drawer: z.string().max(120).optional(), bank: z.string().max(80).optional(),
    branch: z.string().max(80).optional(), city: z.string().max(60).optional(), chequeNo: z.string().max(12).optional(),
    chequeDate: z.iso.date().nullable().optional(), amountPaise: paise, raseed: z.union([z.literal('new'), z.uuid(), z.null()]).optional(),
  })).max(30),
});
const ChequeStatusBody = z.object({ status: z.enum(['pending', 'cleared', 'bounced']), on: DayIso, reason: z.string().max(120).optional(), chargesPaise: paise.optional() });
const ItemLinesQuery = Range.extend({ brand: z.string().max(80) });

// Masters (the old software's Company and Masters menus).
const signedPaise = z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00);
const ProductBody = z.object({
  // name may be left out on a change (only the group, say), so the name stays exactly as it is.
  id: z.uuid().optional(), name: z.string().trim().min(1).max(60).optional(), hidden: z.boolean().optional(),
  shelfDays: z.number().int().min(1).max(60).optional(), groupId: z.uuid().nullable().optional(),
});
const NameBody = z.object({ id: z.uuid().optional(), name: z.string().trim().min(1).max(60) });
const AreaBody = z.object({ id: z.uuid().optional(), name: z.string().trim().min(1).max(60), code: z.string().trim().max(20).optional(), from: z.string().trim().max(60).optional() });
const StoreBody = z.object({
  id: z.uuid().optional(), name: z.string().trim().min(1).max(120), address: z.string().trim().max(200).optional(),
  contactPerson: z.string().trim().max(80).optional(), phone: z.string().trim().max(15).optional(),
});
const HeadBody = z.object({
  id: z.uuid().optional(), name: z.string().trim().min(1).max(120), type: z.enum(['expense', 'income', 'asset', 'liability']),
  openingPaise: paise.optional(), openingOn: z.iso.date().nullable().optional(),
});
const HeadKey = z.union([z.uuid(), z.string().regex(/^b:[a-z_]{1,30}$/)]);
const HiddenBody = z.object({ hidden: z.boolean().default(true) });
const SupplierOpeningBody = z.object({ id: z.uuid().nullable(), name: z.string().trim().min(1).max(120), openingPaise: signedPaise, openingOn: z.iso.date().nullable().optional() });

// Crate In / Crate Out and Store Entry.
const CrateTypeBody = z.object({ id: z.uuid().optional(), name: z.string().trim().min(1).max(60), depositPaise: paise.optional() });
const CrateMoveBody = z.object({
  day: DayIso, dir: z.enum(['out', 'in']), buyerId: z.uuid().nullable().optional(), party: z.string().trim().max(120).optional(),
  crateTypeId: z.uuid(), qty: z.number().int().positive().max(1_000_000), slipNo: z.number().int().positive().max(9_999_999).nullable().optional(),
  note: z.string().max(200).optional(),
});
const CratePartyQuery = z.union([z.object({ buyerId: z.uuid() }), z.object({ name: z.string().trim().min(1).max(120) })]);
const StoreMoveBody = z.object({
  day: DayIso, dir: z.enum(['in', 'out']), storeId: z.uuid(), truckId: z.uuid(), brandId: z.uuid(), boxes: z.number().int().positive().max(1_000_000),
  kg: z.number().min(0).max(100_000_000).nullable().optional(), rentPaise: paise.optional(), note: z.string().max(200).optional(),
});
const StoreMovesQuery = Range.extend({ store: z.uuid().optional() });

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

// The old software's Reports menu: General Ledger, Trial Balance, Ledger Multiple, Chithi, big transactions, Sale Purchase, Purcha, Backup.
const AccountKey = z.string().regex(/^(pot:(galla|office|bank)|sales|cnote|purchase|bhada_in|apmc|chungi|mazdoori|labour|creditors|b:[a-z_]{1,30}|bj:[a-z_]{1,20}|diff:[a-z_]{1,30}|h:[0-9a-f-]{36})$/, 'khata');
const LedgerQuery = Range.extend({ account: AccountKey, daily: z.enum(['0', '1']).default('0') });
const OnQuery = z.object({ on: z.iso.date().optional() });
const KhatasBody = z.object({ ids: z.array(z.uuid()).min(1).max(2000), from: z.iso.date(), to: z.iso.date(), last: z.number().int().min(1).max(100).optional() });
const BigQuery = Range.extend({ min: z.coerce.number().int().min(0).max(1_000_000_000_00).default(2_00_000_00) });
const SalePurchaseQuery = Range.extend({ by: z.enum(['day', 'month']).default('day') });

// The old software's remaining Transactions: Journal Voucher, Credit Note, Generate Invoices, Bikri Entry.
const SearchQuery = Range.extend({ q: z.string().max(60).default('') });
const JvAccountBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('grahak'), id: z.uuid() }),
  z.object({ kind: z.literal('supplier'), name: z.string().trim().min(1).max(120) }),
  z.object({ kind: z.literal('head'), key: z.string().regex(/^(h:[0-9a-f-]{36}|b:[a-z_]{1,30})$/) }),
]);
const JvBody = z.object({ day: DayIso, dr: JvAccountBody, cr: JvAccountBody, amountPaise: paise.positive(), narration: z.string().max(200).optional() });
const CnBody = z.object({
  day: DayIso, buyerId: z.uuid(), billId: z.uuid().nullable().optional(), reason: z.enum(Object.keys(CN_REASONS) as [keyof typeof CN_REASONS, ...(keyof typeof CN_REASONS)[]]),
  lines: z.array(z.object({ quality: z.string().trim().min(1).max(60), grade: z.string().max(4).optional(), boxes: z.number().int().positive().max(10_000_000), ratePaise: paise.positive() })).max(30).optional(),
  amountPaise: paise.optional(), note: z.string().max(200).optional(),
});
const InvoiceParchiQuery = Range.extend({ buyerId: z.uuid().optional() });
const InvoiceBody = z.object({ billIds: z.array(z.uuid()).min(1).max(500), mode: z.enum(['each', 'one']), day: DayIso });
const IdsBody = z.object({ ids: z.array(z.uuid()).min(1).max(500) });
const CancelBody = z.object({ reason: z.string().max(200).default('') });
const BikriBody = z.object({
  truckId: z.uuid().optional(), labour: z.boolean().optional(), labourRatePaise: z.number().int().min(0).max(100_000).optional(), staff: z.string().max(60).optional(),
  rows: z.array(z.object({
    buyerId: z.uuid().optional(), buyerName: z.string().trim().max(120).optional(), truckId: z.uuid().optional(), brandId: z.uuid().optional(), grade: grade.optional(),
    qty: z.number().int().min(0).max(10_000_000), ratePaise: paise, pay: z.enum(['credit', 'cash', 'upi']).optional(),
  })).min(1).max(200),
});

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
    private readonly alerts: UdhaarAlertsService, private readonly reminders: RemindersService, private readonly creditors: CreditorsService,
    private readonly machines: MachinesService, private readonly deposits: DepositsService, private readonly masters: MastersService,
    private readonly crates: CratesService, private readonly coldStore: ColdStoreService, private readonly books: BooksService,
    private readonly vouchers: VouchersService, private readonly invoices: InvoicesService,
  ) {}

  // ---------------------------------------------------------------- Journal Voucher

  @Get('shops/:id/jv/options')
  jvOptions(@See() v: Viewer, @Param('id') id: string) {
    return this.vouchers.jvOptions(mine(v, id));
  }

  @Get('shops/:id/jv')
  jvList(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(SearchQuery, query);
    return this.vouchers.jvList(mine(v, id), r.from, r.to, r.q);
  }

  @Get('shops/:id/jv/:jid')
  jvOne(@See() v: Viewer, @Param('id') id: string, @Param('jid') jid: string) {
    return this.vouchers.jvOne(mine(v, id), parse(Id, jid));
  }

  @Post('shops/:id/jv')
  newJv(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.vouchers.jvSave(v.phone, mine(v, id), null, parse(JvBody, body));
  }

  @Post('shops/:id/jv/:jid')
  @HttpCode(200)
  editJv(@See() v: Viewer, @Param('id') id: string, @Param('jid') jid: string, @Body() body: unknown) {
    return this.vouchers.jvSave(v.phone, mine(v, id), parse(Id, jid), parse(JvBody, body));
  }

  @Post('shops/:id/jv/:jid/delete')
  @HttpCode(200)
  removeJv(@See() v: Viewer, @Param('id') id: string, @Param('jid') jid: string) {
    return this.vouchers.jvRemove(v.phone, mine(v, id), parse(Id, jid));
  }

  // ---------------------------------------------------------------- Credit Note

  @Get('shops/:id/credit-notes')
  cnList(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(SearchQuery, query);
    return this.vouchers.cnList(mine(v, id), r.from, r.to, r.q);
  }

  /** A grahak's parchis to pick one from, and one parchi's lines. */
  @Get('shops/:id/credit-notes/slips/:buyerId')
  cnSlips(@See() v: Viewer, @Param('id') id: string, @Param('buyerId') buyerId: string) {
    return this.vouchers.cnSlips(mine(v, id), parse(Id, buyerId));
  }

  @Get('shops/:id/credit-notes/slip/:billId')
  cnSlip(@See() v: Viewer, @Param('id') id: string, @Param('billId') billId: string) {
    return this.vouchers.cnSlip(mine(v, id), parse(Id, billId));
  }

  @Get('shops/:id/credit-notes/:cid')
  cnOne(@See() v: Viewer, @Param('id') id: string, @Param('cid') cid: string) {
    return this.vouchers.cnOne(mine(v, id), parse(Id, cid));
  }

  @Post('shops/:id/credit-notes')
  newCn(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.vouchers.cnSave(v.phone, mine(v, id), null, parse(CnBody, body));
  }

  @Post('shops/:id/credit-notes/:cid')
  @HttpCode(200)
  editCn(@See() v: Viewer, @Param('id') id: string, @Param('cid') cid: string, @Body() body: unknown) {
    return this.vouchers.cnSave(v.phone, mine(v, id), parse(Id, cid), parse(CnBody, body));
  }

  @Post('shops/:id/credit-notes/:cid/delete')
  @HttpCode(200)
  removeCn(@See() v: Viewer, @Param('id') id: string, @Param('cid') cid: string) {
    return this.vouchers.cnRemove(v.phone, mine(v, id), parse(Id, cid));
  }

  // ---------------------------------------------------------------- Generate Invoices

  @Get('shops/:id/invoices/parchis')
  invoiceParchis(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(InvoiceParchiQuery, query);
    return this.invoices.parchis(mine(v, id), r.from, r.to, r.buyerId);
  }

  @Get('shops/:id/invoices')
  invoiceList(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(SearchQuery, query);
    return this.invoices.list(mine(v, id), r.from, r.to, r.q);
  }

  /** Several invoices in full, for one print. */
  @Post('shops/:id/invoices/docs')
  @HttpCode(200)
  invoiceDocs(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.invoices.docs(mine(v, id), parse(IdsBody, body).ids);
  }

  @Get('shops/:id/invoices/:iid')
  invoice(@See() v: Viewer, @Param('id') id: string, @Param('iid') iid: string) {
    return this.invoices.one(mine(v, id), parse(Id, iid));
  }

  @Post('shops/:id/invoices')
  generateInvoices(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.invoices.generate(v.phone, mine(v, id), parse(InvoiceBody, body));
  }

  @Post('shops/:id/invoices/:iid/cancel')
  @HttpCode(200)
  cancelInvoice(@See() v: Viewer, @Param('id') id: string, @Param('iid') iid: string, @Body() body: unknown) {
    return this.invoices.cancel(mine(v, id), parse(Id, iid), parse(CancelBody, body ?? {}).reason);
  }

  // ---------------------------------------------------------------- Bikri Entry

  /** One gaadi to many grahak: a parchi per row, through the parchi writer. */
  @Post('shops/:id/bikri')
  bikri(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.vouchers.bikri(v.phone, mine(v, id), parse(BikriBody, body));
  }

  // ---------------------------------------------------------------- Crate In / Crate Out

  @Get('shops/:id/crate-types')
  crateTypes(@See() v: Viewer, @Param('id') id: string) {
    return this.crates.types(mine(v, id));
  }

  @Post('shops/:id/crate-types')
  saveCrateType(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.crates.saveType(mine(v, id), parse(CrateTypeBody, body));
  }

  /** Hides a crate type with entries (deletes an unused one); { hidden: false } brings it back. */
  @Post('shops/:id/crate-types/:tid/delete')
  @HttpCode(200)
  deleteCrateType(@See() v: Viewer, @Param('id') id: string, @Param('tid') tid: string, @Body() body: unknown) {
    return this.crates.deleteType(mine(v, id), parse(Id, tid), parse(HiddenBody, body ?? {}).hidden);
  }

  @Get('shops/:id/crates')
  crateRegister(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range, query);
    if (r.from > r.to) throw new BadRequestException('from is after to');
    return this.crates.register(mine(v, id), r.from, r.to);
  }

  @Get('shops/:id/crates/party')
  crateParty(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    return this.crates.party(mine(v, id), parse(CratePartyQuery, query));
  }

  @Get('shops/:id/crates/:mid')
  crateMove(@See() v: Viewer, @Param('id') id: string, @Param('mid') mid: string) {
    return this.crates.one(mine(v, id), parse(Id, mid));
  }

  @Post('shops/:id/crates')
  newCrateMove(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.crates.save(v.phone, mine(v, id), null, parse(CrateMoveBody, body));
  }

  @Post('shops/:id/crates/:mid')
  @HttpCode(200)
  editCrateMove(@See() v: Viewer, @Param('id') id: string, @Param('mid') mid: string, @Body() body: unknown) {
    return this.crates.save(v.phone, mine(v, id), parse(Id, mid), parse(CrateMoveBody, body));
  }

  @Post('shops/:id/crates/:mid/delete')
  @HttpCode(200)
  removeCrateMove(@See() v: Viewer, @Param('id') id: string, @Param('mid') mid: string) {
    return this.crates.remove(mine(v, id), parse(Id, mid));
  }

  // ---------------------------------------------------------------- Store Entry (cold store in/out)

  @Get('shops/:id/store-stock')
  storeStock(@See() v: Viewer, @Param('id') id: string) {
    return this.coldStore.stock(mine(v, id));
  }

  @Get('shops/:id/store-moves')
  storeMoves(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(StoreMovesQuery, query);
    if (r.from > r.to) throw new BadRequestException('from is after to');
    return this.coldStore.moves(mine(v, id), r.from, r.to, r.store);
  }

  @Get('shops/:id/store-moves/:mid')
  storeMove(@See() v: Viewer, @Param('id') id: string, @Param('mid') mid: string) {
    return this.coldStore.one(mine(v, id), parse(Id, mid));
  }

  @Post('shops/:id/store-moves')
  newStoreMove(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.coldStore.save(v.phone, mine(v, id), null, parse(StoreMoveBody, body));
  }

  @Post('shops/:id/store-moves/:mid')
  @HttpCode(200)
  editStoreMove(@See() v: Viewer, @Param('id') id: string, @Param('mid') mid: string, @Body() body: unknown) {
    return this.coldStore.save(v.phone, mine(v, id), parse(Id, mid), parse(StoreMoveBody, body));
  }

  @Post('shops/:id/store-moves/:mid/delete')
  @HttpCode(200)
  removeStoreMove(@See() v: Viewer, @Param('id') id: string, @Param('mid') mid: string) {
    return this.coldStore.remove(v.phone, mine(v, id), parse(Id, mid));
  }

  // ---------------------------------------------------------------- Masters: products, groups, areas, stores, heads, openings

  @Get('shops/:id/products')
  products(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    return this.masters.products(mine(v, id), parse(FyQuery, query).fy);
  }

  @Post('shops/:id/products')
  saveProduct(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.masters.saveProduct(v.phone, mine(v, id), parse(ProductBody, body));
  }

  /** The products in their new order, top first. */
  @Post('shops/:id/products/order')
  @HttpCode(200)
  orderProducts(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.masters.orderProducts(v.phone, mine(v, id), parse(z.object({ ids: z.array(z.uuid()).min(1).max(500) }), body).ids);
  }

  @Post('shops/:id/product-groups')
  saveGroup(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.masters.saveGroup(mine(v, id), parse(NameBody, body));
  }

  @Post('shops/:id/product-groups/:gid/delete')
  @HttpCode(200)
  deleteGroup(@See() v: Viewer, @Param('id') id: string, @Param('gid') gid: string) {
    return this.masters.deleteGroup(mine(v, id), parse(Id, gid));
  }

  @Get('shops/:id/areas')
  areas(@See() v: Viewer, @Param('id') id: string) {
    return this.masters.areas(mine(v, id));
  }

  /** Adds or renames an area; a rename rewrites it on every grahak and supplier in it. */
  @Post('shops/:id/areas')
  saveArea(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.masters.saveArea(v.phone, mine(v, id), parse(AreaBody, body));
  }

  @Post('shops/:id/areas/:aid/delete')
  @HttpCode(200)
  deleteArea(@See() v: Viewer, @Param('id') id: string, @Param('aid') aid: string) {
    return this.masters.deleteArea(mine(v, id), parse(Id, aid));
  }

  @Get('shops/:id/stores')
  stores(@See() v: Viewer, @Param('id') id: string) {
    return this.masters.stores(mine(v, id));
  }

  @Post('shops/:id/stores')
  saveStore(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.masters.saveStore(mine(v, id), parse(StoreBody, body));
  }

  @Post('shops/:id/stores/:sid/hide')
  @HttpCode(200)
  hideStore(@See() v: Viewer, @Param('id') id: string, @Param('sid') sid: string, @Body() body: unknown) {
    return this.masters.hideStore(mine(v, id), parse(Id, sid), parse(HiddenBody, body ?? {}).hidden);
  }

  @Get('shops/:id/heads')
  heads(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    return this.masters.heads(mine(v, id), parse(FyQuery, query).fy);
  }

  @Get('shops/:id/heads/:key')
  headLedger(@See() v: Viewer, @Param('id') id: string, @Param('key') key: string, @Query() query: unknown) {
    return this.masters.headLedger(mine(v, id), parse(HeadKey, key), parse(FyQuery, query).fy);
  }

  @Post('shops/:id/heads')
  saveHead(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.masters.saveHead(mine(v, id), parse(HeadBody, body));
  }

  /** Hides a head with entries (deletes an unused one); { hidden: false } brings it back. */
  @Post('shops/:id/heads/:hid/delete')
  @HttpCode(200)
  deleteHead(@See() v: Viewer, @Param('id') id: string, @Param('hid') hid: string, @Body() body: unknown) {
    return this.masters.deleteHead(mine(v, id), parse(Id, hid), parse(HiddenBody, body ?? {}).hidden);
  }

  @Get('shops/:id/openings')
  openings(@See() v: Viewer, @Param('id') id: string) {
    return this.masters.openings(mine(v, id));
  }

  @Post('shops/:id/openings/grahak/:buyerId')
  @HttpCode(200)
  grahakOpening(@See() v: Viewer, @Param('id') id: string, @Param('buyerId') buyerId: string, @Body() body: unknown) {
    return this.masters.setGrahakOpening(v.phone, mine(v, id), parse(Id, buyerId), parse(z.object({ openingPaise: signedPaise }), body).openingPaise);
  }

  @Post('shops/:id/openings/supplier')
  @HttpCode(200)
  supplierOpening(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(SupplierOpeningBody, body);
    return this.masters.setSupplierOpening(v.phone, mine(v, id), { ...b, openingOn: b.openingOn ?? null });
  }

  @Post('shops/:id/openings/head/:hid')
  @HttpCode(200)
  headOpening(@See() v: Viewer, @Param('id') id: string, @Param('hid') hid: string, @Body() body: unknown) {
    const b = parse(z.object({ openingPaise: paise, openingOn: z.iso.date().nullable().optional() }), body);
    return this.masters.setHeadOpening(mine(v, id), parse(Id, hid), b.openingPaise, b.openingOn ?? null);
  }

  // ---------------------------------------------------------------- bank jama parchi (deposit slips)

  @Get('shops/:id/deposits')
  depositList(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range, query);
    return this.deposits.list(mine(v, id), r.from, r.to);
  }

  /** The cheque register: every cheque on a live slip, by status. */
  @Get('shops/:id/deposits/cheques')
  depositCheques(@See() v: Viewer, @Param('id') id: string, @Query('status') status?: string, @Query('q') q?: string) {
    return this.deposits.cheques(mine(v, id), ['pending', 'cleared', 'bounced'].includes(status ?? '') ? status! : '', (q ?? '').slice(0, 60));
  }

  @Get('shops/:id/deposits/form')
  depositForm(@See() v: Viewer, @Param('id') id: string) {
    return this.deposits.form(mine(v, id));
  }

  @Get('shops/:id/deposits/grahak/:buyerId')
  depositGrahak(@See() v: Viewer, @Param('id') id: string, @Param('buyerId') buyerId: string) {
    return this.deposits.grahak(mine(v, id), parse(Id, buyerId));
  }

  @Get('shops/:id/deposits/:slipId')
  deposit(@See() v: Viewer, @Param('id') id: string, @Param('slipId') slipId: string) {
    return this.deposits.one(mine(v, id), parse(Id, slipId));
  }

  @Post('shops/:id/deposits')
  newDeposit(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.deposits.save(v.phone, mine(v, id), null, parse(DepositBody, body) as never);
  }

  @Post('shops/:id/deposits/:slipId')
  editDeposit(@See() v: Viewer, @Param('id') id: string, @Param('slipId') slipId: string, @Body() body: unknown) {
    return this.deposits.save(v.phone, mine(v, id), parse(Id, slipId), parse(DepositBody, body) as never);
  }

  @Post('shops/:id/deposits/:slipId/delete')
  removeDeposit(@See() v: Viewer, @Param('id') id: string, @Param('slipId') slipId: string) {
    return this.deposits.remove(v.phone, mine(v, id), parse(Id, slipId));
  }

  @Post('shops/:id/deposits/cheques/:chequeId/status')
  chequeStatus(@See() v: Viewer, @Param('id') id: string, @Param('chequeId') chequeId: string, @Body() body: unknown) {
    return this.deposits.status(v.phone, mine(v, id), parse(Id, chequeId), parse(ChequeStatusBody, body));
  }

  // ---------------------------------------------------------------- machines MandiPlus hands out (admin only)

  /** Every machine: serial, with whom since when, its app login; plus the logins it could be. */
  @Get('machines')
  machineList(@See() v: Viewer) {
    adminOnly(v);
    return this.machines.list();
  }

  @Get('machines/:mid/history')
  machineHistory(@See() v: Viewer, @Param('mid') mid: string) {
    adminOnly(v);
    return this.machines.history(parse(Id, mid));
  }

  /** A new machine into the register (in stock). */
  @Post('machines')
  addMachine(@See() v: Viewer, @Body() body: unknown) {
    adminOnly(v);
    return this.machines.save(null, parse(MachineBody, body), v.phone);
  }

  @Post('machines/:mid')
  editMachine(@See() v: Viewer, @Param('mid') mid: string, @Body() body: unknown) {
    adminOnly(v);
    return this.machines.save(parse(Id, mid), parse(MachineBody, body), v.phone);
  }

  @Post('machines/:mid/give')
  giveMachine(@See() v: Viewer, @Param('mid') mid: string, @Body() body: unknown) {
    adminOnly(v);
    return this.machines.give(parse(Id, mid), parse(GiveBody, body), v.phone);
  }

  @Post('machines/:mid/back')
  machineBack(@See() v: Viewer, @Param('mid') mid: string, @Body() body: unknown) {
    adminOnly(v);
    return this.machines.back(parse(Id, mid), parse(BackBody, body), v.phone);
  }

  @Post('machines/:mid/link')
  linkMachine(@See() v: Viewer, @Param('mid') mid: string, @Body() body: unknown) {
    adminOnly(v);
    return this.machines.link(parse(Id, mid), parse(LinkBody, body).deviceId, v.phone);
  }

  // ---------------------------------------------------------------- supplier creditors and laddan (angoor)

  /** Every supplier for a financial year (April to March): carried opening, beejaks, paid, balance. */
  @Get('shops/:id/creditors')
  creditorList(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    return this.creditors.list(mine(v, id), parse(FyQuery, query).fy);
  }

  @Get('shops/:id/creditors/:key')
  creditorKhata(@See() v: Viewer, @Param('id') id: string, @Param('key') key: string, @Query() query: unknown) {
    return this.creditors.khata(mine(v, id), key.slice(0, 120), parse(FyQuery, query).fy);
  }

  /** Adds or changes a supplier on the creditors' list (name, code, area, phone, opening balance). */
  @Post('shops/:id/creditors')
  saveCreditor(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.entries.saveSupplier(v.phone, mine(v, id), parse(SupplierBody, body));
  }

  /** Laddan parties with their master fields and balances. */
  @Get('shops/:id/laddan')
  laddan(@See() v: Viewer, @Param('id') id: string, @Query('q') q?: string) {
    return this.creditors.laddan(mine(v, id), (q ?? '').slice(0, 60));
  }

  /** Changes a grahak or laddan party's details (only what is sent). */
  @Post('shops/:id/grahak/:buyerId')
  async editGrahak(@See() v: Viewer, @Param('id') id: string, @Param('buyerId') buyerId: string, @Body() body: unknown) {
    const shopId = mine(v, id), bid = parse(z.uuid(), buyerId);
    const { gstin, ...patch } = parse(GrahakPatchBody, body);
    if (gstin && !GSTIN.test(gstin)) throw new BadRequestException('GSTIN 15 akshar ka hota hai (jaise 07ABCDE1234F1Z5)');
    const done = Object.keys(patch).length || gstin === undefined ? await this.entries.updateGrahak(v.phone, shopId, bid, patch) : { id: bid };
    if (gstin === undefined) return done;
    return { ...done, gstin: (await this.invoices.setGstin(shopId, bid, gstin)).gstin };
  }

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
    return { phone: v.phone, admin: v.admin, shopIds: v.admin ? null : v.shopIds, labourShopIds: v.labourShopIds };
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

  /** The grapes desk: dispatch, open gaadis and where they stand, party commission, APMC, mazdoori. */
  @Get('shops/:id/angoor')
  angoor(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range.extend({ commissionBps: z.coerce.number().int().min(0).max(5000).default(600) }), query);
    return this.insights.angoor(mine(v, id), r.from, r.to, r.commissionBps);
  }

  /** The beejaks the shop has made, newest first. */
  @Get('shops/:id/beejaks')
  beejaks(@See() v: Viewer, @Param('id') id: string, @Query('q') q?: string) {
    return this.insights.beejaks(mine(v, id), (q ?? '').slice(0, 60));
  }

  @Get('shops/:id/beejaks/:bid')
  beejakById(@See() v: Viewer, @Param('id') id: string, @Param('bid') bid: string) {
    return this.insights.beejakById(mine(v, id), parse(z.uuid(), bid));
  }

  /** Makes (or makes again) a gaadi's beejak and keeps it. */
  @Post('shops/:id/beejak/:truckId')
  saveBeejak(@See() v: Viewer, @Param('id') id: string, @Param('truckId') truckId: string, @Body() body: unknown) {
    return this.insights.saveBeejak(v.phone, mine(v, id), parse(z.uuid(), truckId), parse(BeejakBody, body));
  }

  /** A party's beejak for one gaadi: qualities sold, average bhav, gross and bhada. */
  @Get('shops/:id/beejak/:truckId')
  beejak(@See() v: Viewer, @Param('id') id: string, @Param('truckId') truckId: string) {
    return this.insights.beejak(mine(v, id), parse(z.uuid(), truckId));
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
  /** The parchi to the shop's print machine again. */
  @Post('shops/:id/bills/:billId/print')
  printBill(@See() v: Viewer, @Param('id') id: string, @Param('billId') billId: string) {
    return this.entries.reprint(v.phone, mine(v, id), parse(Id, billId));
  }

  @Get('shops/:id/print-station')
  printStation(@See() v: Viewer, @Param('id') id: string) {
    return this.entries.printStation(v.phone, mine(v, id));
  }

  @Get('shops/:id/bills/:billId')
  bill(@See() v: Viewer, @Param('id') id: string, @Param('billId') billId: string) {
    return this.admin.bill(mine(v, id), parse(Id, billId));
  }

  @Get('shops/:id/buyers')
  async buyers(@See() v: Viewer, @Param('id') id: string, @Query('q') q?: string, @Query('area') area?: string) {
    return { buyers: await this.admin.buyers(mine(v, id), (q ?? '').trim().slice(0, 60), (area ?? '').slice(0, 60)) };
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

  /** Dispatch at the gaadi: a slip by its QR (bill id) or number, and boxes handed over against it. */
  @Get('shops/:id/pickup')
  pickupSlip(@See() v: Viewer, @Param('id') id: string, @Query('code') code?: string) {
    return this.entries.pickupSlip(mine(v, id), parse(z.string().trim().min(1).max(40), code ?? ''));
  }

  @Post('shops/:id/breakages')
  reportBreakage(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.entries.reportBreakage(v.phone, mine(v, id), parse(z.object({
      billId: z.uuid(), brandId: z.uuid().nullable(), truckId: z.uuid().nullable(), qty: z.number().int().min(1).max(100000), note: z.string().trim().max(200).optional(),
    }), body));
  }

  @Get('shops/:id/labour')
  labourHome(@See() v: Viewer, @Param('id') id: string) {
    return this.entries.labourHome(v.phone, mine(v, id));
  }

  @Post('shops/:id/pickup')
  pickup(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    return this.entries.pickup(v.phone, mine(v, id), parse(z.object({ billId: z.uuid(), qty: z.number().int().min(1).max(100000) }), body));
  }

  /** A grapes gaadi changed: number, supplier, place, bhada, and each quality's boxes. */
  @Post('shops/:id/gaadi/:truckId')
  editGaadi(@See() v: Viewer, @Param('id') id: string, @Param('truckId') truckId: string, @Body() body: unknown) {
    return this.entries.editGaadi(v.phone, mine(v, id), parse(z.uuid(), truckId), parse(GaadiBody, body));
  }

  /** Angoor: broken-box requests from the gaadi, and the accountant settling one (re-priced) or turning it down. */
  @Get('shops/:id/breakages')
  breakages(@See() v: Viewer, @Param('id') id: string, @Query('status') status?: string) {
    return this.entries.breakages(mine(v, id), status === 'all' ? 'all' : 'pending');
  }

  @Post('shops/:id/breakages/:bid/resolve')
  resolveBreakage(@See() v: Viewer, @Param('id') id: string, @Param('bid') bid: string, @Body() body: unknown) {
    return this.entries.resolveBreakage(v.phone, mine(v, id), parse(z.uuid(), bid),
      parse(z.object({ ratePaise: paise, giveBack: z.enum(['cash', 'advance']).optional() }), body));
  }

  @Post('shops/:id/breakages/:bid/reject')
  rejectBreakage(@See() v: Viewer, @Param('id') id: string, @Param('bid') bid: string) {
    return this.entries.rejectBreakage(v.phone, mine(v, id), parse(z.uuid(), bid));
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
  async daybookEntry(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    const shopId = mine(v, id);
    const { headId, ...b } = parse(DaybookBody, body);
    if (!headId) return this.entries.daybook(v.phone, shopId, b);
    const h = await this.masters.headEntry(shopId, headId, b.direction);
    return this.entries.daybook(v.phone, shopId, { ...b, category: h.category, party: h.party, note: b.note?.trim() || h.party });
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

  /** Maal-wise Bikri, one maal opened: every line it was sold on — to whom, at what bhav. */
  @Get('shops/:id/items/lines')
  itemLines(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(ItemLinesQuery, query);
    return this.reports.itemLines(mine(v, id), r.from, r.to, r.brand);
  }

  @Get('shops/:id/items')
  items(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range, query);
    return this.reports.items(mine(v, id), r.from, r.to);
  }

  // ---------------------------------------------------------------- Reports: ledgers, trial balance, letters, backup

  @Get('shops/:id/books/accounts')
  bookAccounts(@See() v: Viewer, @Param('id') id: string) {
    return this.books.accounts(mine(v, id));
  }

  /** One account over a period: brought forward, every entry, carried forward. */
  @Get('shops/:id/books/ledger')
  bookLedger(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(LedgerQuery, query);
    return this.books.ledger(mine(v, id), r.account, r.from, r.to, r.daily === '1');
  }

  @Get('shops/:id/books/trial-balance')
  trialBalance(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    return this.books.trialBalance(mine(v, id), parse(OnQuery, query).on ?? todayIst());
  }

  /** Every grahak and laddan party with area and baaki as on a date (Ledger Multiple's list, the Schedule). */
  @Get('shops/:id/books/parties')
  bookParties(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    return this.books.parties(mine(v, id), parse(OnQuery, query).on ?? todayIst());
  }

  /** Many grahak's khatas over a period, for one print. */
  @Post('shops/:id/books/khatas')
  @HttpCode(200)
  khatas(@See() v: Viewer, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(KhatasBody, body);
    return this.admin.khatas(mine(v, id), b.ids, b.from, b.to, b.last).then((khatas) => ({ from: b.from, to: b.to, khatas }));
  }

  @Get('shops/:id/books/big')
  bigTransactions(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(BigQuery, query);
    return this.books.big(mine(v, id), r.from, r.to, r.min);
  }

  @Get('shops/:id/books/sale-purchase')
  salePurchase(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(SalePurchaseQuery, query);
    return this.books.salePurchase(mine(v, id), r.from, r.to, r.by);
  }

  @Get('shops/:id/books/purcha')
  purcha(@See() v: Viewer, @Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range, query);
    return this.books.purcha(mine(v, id), r.from, r.to);
  }

  /** The shop's complete books as one Excel workbook, streamed. Read-only. */
  @Get('shops/:id/books/backup')
  async backup(@See() v: Viewer, @Param('id') id: string, @Res() res: Response) {
    const shopId = mine(v, id);
    const shop = await this.admin.shop(shopId);
    const file = `${shop.name.replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'shop'}-backup-${todayIst()}.xlsx`;
    res.status(200).set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${file.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file)}`,
      'Cache-Control': 'no-store',
    });
    try {
      await this.books.backup(shopId, res);
      res.end();
    } catch (e) {
      // Headers are gone; a cut-off file is better refused than half-saved as a backup.
      res.destroy(e as Error);
    }
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
