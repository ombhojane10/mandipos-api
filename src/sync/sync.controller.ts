import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, Me, requireShop } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse } from '../common/validate';
import { MAX_PULL_LIMIT, MAX_PUSH_ITEMS, SyncService } from './sync.service';

const PushBody = z.object({
  items: z.array(z.object({ table: z.string(), row: z.record(z.string(), z.unknown()) })).max(MAX_PUSH_ITEMS),
});
const PullQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).default(MAX_PULL_LIMIT),
});

@Controller('v1/sync')
@UseGuards(AuthGuard)
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /** Device → server: new rows from the outbox, in the order they were written. */
  @Post('push')
  @HttpCode(200)
  async push(@Me() p: Principal, @Body() body: unknown) {
    const shopId = requireShop(p);
    return { results: await this.sync.push(p, shopId, parse(PushBody, body).items) };
  }

  /** Server → device: everything the shop's devices wrote after `after`, one page at a time. */
  @Get('pull')
  pull(@Me() p: Principal, @Query() query: unknown) {
    const q = parse(PullQuery, query);
    return this.sync.pull(requireShop(p), q.after, q.limit);
  }
}
