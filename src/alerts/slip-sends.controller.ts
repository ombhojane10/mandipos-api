import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, Me } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse } from '../common/validate';
import { SlipSendsService } from './slip-sends.service';

const SendBody = z.object({
  id: z.uuid(),
  phone: z.string().trim().regex(/^[6-9][0-9]{9}$/, 'a 10-digit mobile number'),
  image: z.string().min(8).max(600_000),
  params: z.array(z.string().max(200)).min(1).max(6),
});

/** Angoor: a slip to its grahak, a beejak to its party, on WhatsApp. */
@Controller('v1/whatsapp')
@UseGuards(AuthGuard)
export class SlipSendsController {
  constructor(private readonly sends: SlipSendsService) {}

  @Post('slip')
  @HttpCode(200)
  slip(@Me() p: Principal, @Body() body: unknown) {
    const b = parse(SendBody, body);
    return this.sends.send(p, 'slip', b.id, b.phone, b.image, b.params);
  }

  @Post('beejak')
  @HttpCode(200)
  beejak(@Me() p: Principal, @Body() body: unknown) {
    const b = parse(SendBody, body);
    return this.sends.send(p, 'beejak', b.id, b.phone, b.image, b.params);
  }
}
