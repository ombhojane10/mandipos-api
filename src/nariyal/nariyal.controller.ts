import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, Me } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse } from '../common/validate';
import { NariyalBeejakBody, NariyalBeejakService } from './nariyal-beejak.service';

/**
 * Nariyal shops only, from the terminal. Every route refuses any other shop (422), and the
 * beejak routes any gaadi not taken on Commission.
 */
@Controller('v1/nariyal')
@UseGuards(AuthGuard)
export class NariyalAppController {
  constructor(private readonly beejaks: NariyalBeejakService) {}

  /** `?truckIds=a,b,…` (at most 100): each one's saved beejak number and net, for Bikri's "All paid". */
  @Get('beejaks')
  nets(@Me() p: Principal, @Query('truckIds') truckIds?: string) {
    const ids = (truckIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return this.beejaks.nets(shop(p), parse(z.array(z.uuid()).max(100), ids));
  }

  @Get('beejaks/:truckId')
  beejak(@Me() p: Principal, @Param('truckId') truckId: string) {
    return this.beejaks.beejak(shop(p), parse(z.uuid(), truckId));
  }

  @Post('beejaks/:truckId')
  save(@Me() p: Principal, @Param('truckId') truckId: string, @Body() body: unknown) {
    return this.beejaks.save(shop(p), parse(z.uuid(), truckId), parse(NariyalBeejakBody, body));
  }
}

function shop(p: Principal): string {
  if (!p.shopId) throw new ForbiddenException('Pehle dukaan se judein');
  if (p.role === 'labour') throw new ForbiddenException('Labour login sirf scan kar sakta hai');
  return p.shopId;
}
