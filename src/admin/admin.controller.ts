import {
  Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, HttpCode, Injectable, Param, Post, Query,
  UnauthorizedException, UseGuards, createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { OtpService } from '../auth/otp.service';
import { adminPhones, config } from '../config';
import { parse, phone } from '../common/validate';
import { Db } from '../db/db.service';
import { AdminService } from './admin.service';
import { ReportsService, type Pot } from './reports.service';

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
  constructor(private readonly admin: AdminService, private readonly reports: ReportsService) {}

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
  stock(@See() v: Viewer, @Param('id') id: string) {
    return this.reports.stock(mine(v, id), todayIst());
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
