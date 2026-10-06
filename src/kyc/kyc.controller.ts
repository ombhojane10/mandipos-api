import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, Me } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse } from '../common/validate';
import { KycService, OtpBody, StartBody } from './kyc.service';

const Id = z.uuid();

/** A grahak's eKYC: start (Aadhaar details → OTP), confirm (OTP → e-Aadhaar + PAN saved), read. */
@Controller('v1/buyers')
@UseGuards(AuthGuard)
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Post(':id/kyc')
  @HttpCode(200)
  start(@Me() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.kyc.start(p, parse(Id, id), parse(StartBody, body));
  }

  @Post(':id/kyc/otp')
  @HttpCode(200)
  confirm(@Me() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.kyc.confirm(p, parse(Id, id), parse(OtpBody, body));
  }

  @Get(':id/kyc')
  get(@Me() p: Principal, @Param('id') id: string) {
    return this.kyc.get(p, parse(Id, id));
  }
}

