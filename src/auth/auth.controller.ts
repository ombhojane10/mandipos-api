import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parse, phone } from '../common/validate';
import { AccountsService } from './accounts.service';
import { AuthGuard, Me } from './auth.guard';
import { OtpService } from './otp.service';
import { Principal, TokensService } from './tokens.service';

const OtpBody = z.object({ phone });
const VerifyBody = z.object({
  phone,
  code: z.string().regex(/^\d{4,8}$/, 'must be the OTP digits'),
  // Sent by a device that logged in before, so it keeps its bill series.
  deviceId: z.uuid().optional(),
  device: z.object({
    label: z.string().max(80).default(''),
    platform: z.string().max(40).default(''),
    appVersion: z.string().max(40).default(''),
  }).default({ label: '', platform: '', appVersion: '' }),
});
const RefreshBody = z.object({ refreshToken: z.string().min(20) });

@Controller('v1')
export class AuthController {
  constructor(
    private readonly otp: OtpService,
    private readonly accounts: AccountsService,
    private readonly tokens: TokensService,
  ) {}

  @Post('auth/otp')
  @HttpCode(204)
  async sendOtp(@Body() body: unknown) {
    await this.otp.send(parse(OtpBody, body).phone);
  }

  @Post('auth/verify')
  @HttpCode(200)
  async verify(@Body() body: unknown) {
    const b = parse(VerifyBody, body);
    await this.otp.verify(b.phone, b.code);
    return this.accounts.login(b.phone, b.deviceId, b.device);
  }

  @Post('auth/refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown) {
    return this.tokens.rotate(parse(RefreshBody, body).refreshToken);
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Body() body: unknown) {
    await this.tokens.revoke(parse(RefreshBody, body).refreshToken);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Me() p: Principal) {
    return this.accounts.meFor(p);
  }
}
