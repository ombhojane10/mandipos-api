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
import { AdminService } from './admin.service';

/** Admin tokens are signed with the app's secret but for their own audience, so neither works as the other. */
const AUDIENCE = 'mandipos-admin';
const TTL_SECONDS = 12 * 60 * 60;

type AdminRequest = Request & { admin?: string };

/** Bearer admin token → request.admin (the phone). The number must still be on ADMIN_PHONES. */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException('Login zaroori hai');
    let phoneNo: string;
    try {
      phoneNo = (jwt.verify(header.slice(7), config().JWT_SECRET, { algorithms: ['HS256'], audience: AUDIENCE }) as { sub: string }).sub;
    } catch {
      throw new UnauthorizedException('Session expire ho gaya');
    }
    if (!adminPhones().includes(phoneNo)) throw new UnauthorizedException('Yeh number admin nahi hai');
    req.admin = phoneNo;
    return true;
  }
}

const AdminPhone = createParamDecorator((_: unknown, ctx: ExecutionContext): string =>
  ctx.switchToHttp().getRequest<AdminRequest>().admin!);

const Id = z.uuid();
const Day = z.iso.date();
const Range = z.object({ from: Day, to: Day });
const Code = z.object({ phone, code: z.string().regex(/^\d{4,8}$/, 'must be the OTP digits') });
const CustomerKey = z.union([z.string().regex(/^[6-9]\d{9}$/), z.string().regex(/^[0-9a-f-]{36}~[0-9a-f-]{36}$/)]);
const RejectBody = z.object({ reason: z.string().trim().max(200).default('') });

/** Sign-in for the MandiPlus admin portal: OTP to a number on ADMIN_PHONES. */
@Controller('v1/admin/auth')
export class AdminAuthController {
  constructor(private readonly otp: OtpService) {}

  @Post('otp')
  @HttpCode(204)
  async sendOtp(@Body() body: unknown) {
    const p = parse(z.object({ phone }), body).phone;
    allowed(p);
    await this.otp.send(p);
  }

  @Post('verify')
  @HttpCode(200)
  async verify(@Body() body: unknown) {
    const b = parse(Code, body);
    allowed(b.phone);
    await this.otp.verify(b.phone, b.code);
    const token = jwt.sign({ sub: b.phone }, config().JWT_SECRET, { algorithm: 'HS256', audience: AUDIENCE, expiresIn: TTL_SECONDS });
    return { token, phone: b.phone, expiresIn: TTL_SECONDS };
  }
}

/**
 * A number not on the list is refused before any SMS goes out. An admin number that is also on
 * OTP_TEST_LOGINS signs in with its fixed code (Omi's call for 9010101010, 2026-10-15).
 */
function allowed(p: string) {
  if (!adminPhones().includes(p)) throw new ForbiddenException('Yeh number admin nahi hai');
}

@Controller('v1/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('me')
  me(@AdminPhone() p: string) {
    return { phone: p };
  }

  /** Every shop, requests to approve first. */
  @Get('shops')
  async shops() {
    return { shops: await this.admin.shops() };
  }

  @Get('shops/:id')
  shop(@Param('id') id: string) {
    return this.admin.shop(parse(Id, id));
  }

  @Post('shops/:id/approve')
  @HttpCode(204)
  async approve(@Param('id') id: string, @AdminPhone() by: string) {
    await this.admin.approve(parse(Id, id), by);
  }

  @Post('shops/:id/reject')
  @HttpCode(204)
  async reject(@Param('id') id: string, @AdminPhone() by: string, @Body() body: unknown) {
    await this.admin.reject(parse(Id, id), by, parse(RejectBody, body ?? {}).reason);
  }

  /** The app's Home/Hisab figures for business dates [from, to]. */
  @Get('shops/:id/summary')
  summary(@Param('id') id: string, @Query() query: unknown) {
    const r = parse(Range, query);
    return this.admin.summary(parse(Id, id), r.from, r.to);
  }

  /** Grahak across every shop, matched by mobile; empty q = the market's biggest debtors. */
  @Get('customers')
  async customers(@Query('q') q?: string) {
    return { customers: await this.admin.customers((q ?? '').trim().slice(0, 60)) };
  }

  /** One person: a 10-digit mobile, or "shopId~buyerId" for a grahak with none. */
  @Get('customers/:key')
  customer(@Param('key') key: string) {
    return this.admin.customer(parse(CustomerKey, key));
  }

  @Get('shops/:id/buyers')
  async buyers(@Param('id') id: string, @Query('q') q?: string) {
    return { buyers: await this.admin.buyers(parse(Id, id), (q ?? '').trim().slice(0, 60)) };
  }

  @Get('shops/:id/buyers/:buyerId')
  buyer(@Param('id') id: string, @Param('buyerId') buyerId: string) {
    return this.admin.buyer(parse(Id, id), parse(Id, buyerId));
  }
}
