import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { BeejakBody } from '../admin/admin.controller';
import { CreditorsService } from '../admin/creditors.service';
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
  constructor(private readonly insights: InsightsService, private readonly creditorsService: CreditorsService) {}

  @Get(':truckId')
  one(@Me() p: Principal, @Param('truckId') truckId: string) {
    return this.insights.beejak(shop(p), parse(z.uuid(), truckId));
  }

  /** Supplier creditors for the app (read here; the master syncs as supplier_phones). */
  @Get('creditors/list')
  creditors(@Me() p: Principal, @Query('fy') fy?: string) {
    return this.creditorsService.list(shop(p), fy ? parse(z.coerce.number().int().min(2000).max(2100), fy) : undefined);
  }

  @Get('creditors/:key')
  creditor(@Me() p: Principal, @Param('key') key: string, @Query('fy') fy?: string) {
    return this.creditorsService.khata(shop(p), key.slice(0, 120), fy ? parse(z.coerce.number().int().min(2000).max(2100), fy) : undefined);
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
