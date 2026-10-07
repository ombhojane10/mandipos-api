import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, Me } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse } from '../common/validate';
import { DigilockerCompleteBody, DigilockerKycService, DigilockerStartBody } from './digilocker.service';
import { FingersBody, KycService, OtpBody, StartBody } from './kyc.service';

const Id = z.uuid();

/** A grahak's eKYC: start (Aadhaar details → OTP), confirm (OTP → e-Aadhaar + PAN saved), read. */
@Controller('v1/buyers')
@UseGuards(AuthGuard)
export class KycController {
  constructor(private readonly kyc: KycService, private readonly digilocker: DigilockerKycService) {}

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

  /** DigiLocker's own sign-in page (via Surepass): answers with the page for the terminal to open. */
  @Post(':id/kyc/digilocker')
  @HttpCode(200)
  digilockerStart(@Me() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.digilocker.start(p, parse(Id, id), parse(DigilockerStartBody, body));
  }

  /** After the grahak is sent back: fetch and save their Aadhaar (and PAN). 409 = not finished yet. */
  @Post(':id/kyc/digilocker/complete')
  @HttpCode(200)
  digilockerComplete(@Me() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.digilocker.complete(p, parse(Id, id), parse(DigilockerCompleteBody, body));
  }

  /** Fingers on a saved KYC, added or removed later; the list sent replaces the saved one. */
  @Put(':id/kyc/fingers')
  @HttpCode(200)
  setFingers(@Me() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.kyc.setFingers(p, parse(Id, id), parse(FingersBody, body));
  }

  @Get(':id/kyc')
  get(@Me() p: Principal, @Param('id') id: string) {
    return this.kyc.get(p, parse(Id, id));
  }
}


/** Where DigiLocker sends the grahak back. The terminal closes its page on this address; a browser sees this. */
@Controller('v1/kyc/digilocker')
export class DigilockerReturnController {
  @Get('done')
  @Header('Content-Type', 'text/html; charset=utf-8')
  done() {
    return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Done</title>' +
      '<body style="font-family:sans-serif;display:grid;place-items:center;height:90vh;margin:0"><p>DigiLocker done. Return to the app.</p></body>';
  }
}
