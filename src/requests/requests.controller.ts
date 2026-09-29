import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, Me } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse } from '../common/validate';
import { RequestsService } from './requests.service';

const CreateBody = z.object({
  buyerName: z.string().trim().max(120).default(''),
  totalPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  detail: z.record(z.string(), z.unknown()).default({}),
});
const UsedBody = z.object({ billId: z.uuid() });
const Id = z.uuid();

/** Slips above the shop's limit, waiting on an admin. */
@Controller('v1/requests')
@UseGuards(AuthGuard)
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Post()
  create(@Me() p: Principal, @Body() body: unknown) {
    const b = parse(CreateBody, body);
    return this.requests.create(p, b.buyerName, b.totalPaise, b.detail);
  }

  @Get()
  all(@Me() p: Principal) {
    return this.requests.all(p);
  }

  @Get(':id')
  one(@Me() p: Principal, @Param('id') id: string) {
    return this.requests.one(p, parse(Id, id));
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Me() p: Principal, @Param('id') id: string) {
    return this.requests.decide(p, parse(Id, id), true);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Me() p: Principal, @Param('id') id: string) {
    return this.requests.decide(p, parse(Id, id), false);
  }

  @Post(':id/used')
  @HttpCode(204)
  async used(@Me() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    await this.requests.used(p, parse(Id, id), parse(UsedBody, body).billId);
  }
}
