import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, Me, requireShop } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse } from '../common/validate';
import { SyncHub } from './sync.hub';
import { MAX_PULL_LIMIT, MAX_PUSH_ITEMS, SyncService } from './sync.service';

const PushBody = z.object({
  items: z.array(z.object({ table: z.string(), row: z.record(z.string(), z.unknown()), txn: z.string().max(64).optional() })).max(MAX_PUSH_ITEMS),
  // Sent by terminals that understand '_reset'; older ones leave it out and are never refused for it.
  resetSeen: z.number().int().min(0).optional(),
});
const PullQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).default(MAX_PULL_LIMIT),
});
const WaitQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  wait: z.coerce.number().int().min(0).max(25).default(20),
});

@Controller('v1/sync')
@UseGuards(AuthGuard)
export class SyncController {
  constructor(private readonly sync: SyncService, private readonly hub: SyncHub) {}

  /** Device → server: new rows from the outbox, in the order they were written. */
  @Post('push')
  @HttpCode(200)
  async push(@Me() p: Principal, @Body() body: unknown) {
    const shopId = requireShop(p);
    const b = parse(PushBody, body);
    const results = await this.sync.push(p, shopId, b.items, b.resetSeen);
    // The other terminals waiting on this shop pull now, not at their next tick.
    if (results.some((r) => r.status === 'applied')) void this.hub.wake(shopId).catch(() => undefined);
    return { results };
  }

  /** Server → device: everything the shop's devices wrote after `after`, one page at a time. */
  @Get('pull')
  pull(@Me() p: Principal, @Query() query: unknown) {
    const q = parse(PullQuery, query);
    return this.sync.pull(requireShop(p), q.after, q.limit);
  }

  /**
   * Long-poll: answers as soon as the shop's feed has a row after `after` (another terminal's
   * slip, a KYC, a delete), or after `wait` seconds with nothing new. A terminal in the
   * foreground keeps one of these open, so it hears about changes in a second or two.
   */
  @Get('wait')
  wait(@Me() p: Principal, @Query() query: unknown) {
    const q = parse(WaitQuery, query);
    return this.hub.wait(requireShop(p), q.after, q.wait);
  }
}
