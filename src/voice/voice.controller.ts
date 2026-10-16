import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, Me } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse } from '../common/validate';
import { OutcomeBody, TurnBody, VoiceService } from './voice.service';
import { SheetBody, SheetService } from './sheet.service';

/** "Bolo": one recording in, one structured reply out (a draft to check, or what to show). */
@Controller('v1/voice')
@UseGuards(AuthGuard)
export class VoiceController {
  constructor(private readonly voice: VoiceService, private readonly sheet: SheetService) {}

  @Post()
  @HttpCode(200)
  turn(@Me() p: Principal, @Body() body: unknown) {
    return this.voice.turn(p, parse(TurnBody, body));
  }

  /** Udhaar bhav from photos of the day's sheet: each written entry matched to its slip. Nothing is saved. */
  @Post('sheet')
  @HttpCode(200)
  readSheet(@Me() p: Principal, @Body() body: unknown) {
    return this.sheet.read(p, parse(SheetBody, body));
  }

  /** What the counter did with the draft: saved as is, changed first, or dropped. */
  @Post(':id/outcome')
  @HttpCode(200)
  outcome(@Me() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.voice.outcome(p, parse(z.uuid(), id), parse(OutcomeBody, body).outcome);
  }
}
