import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { BeejakBody } from '../admin/admin.controller';
import { InsightsService } from '../admin/insights.service';
import { AuthGuard, Me } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse } from '../common/validate';

const AppBeejakBody = BeejakBody.extend({ by: z.string().trim().max(60).default('') });

/**
 * Angoor: the beejak from the POS — the same kept beejaks as the website (one a gaadi, the same
 * number on both), so one made at the counter opens on the website and the other way round.
 */
@Controller('v1/beejaks')
@UseGuards(AuthGuard)
export class BeejaksController {
  constructor(private readonly insights: InsightsService) {}

  @Get(':truckId')
  one(@Me() p: Principal, @Param('truckId') truckId: string) {
    return this.insights.beejak(shop(p), parse(z.uuid(), truckId));
  }

  @Post(':truckId')
  save(@Me() p: Principal, @Param('truckId') truckId: string, @Body() body: unknown) {
    const b = parse(AppBeejakBody, body);
    return this.insights.saveBeejak(b.by || 'App', shop(p), parse(z.uuid(), truckId), b);
  }
}

function shop(p: Principal): string {
  if (!p.shopId) throw new ForbiddenException('Pehle dukaan se judein');
  if (p.role === 'labour') throw new ForbiddenException('Labour login sirf scan kar sakta hai');
  return p.shopId;
}
