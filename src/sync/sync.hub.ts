import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Db } from '../db/db.service';

export type Counters = { lastSeq: number; resetSeq: number };

type Waiter = { after: number; finish: (c: Counters | null) => void };

/**
 * Terminals waiting for the shop's feed to move (GET /v1/sync/wait). A push on this instance
 * wakes them at once; a short tick catches everything else — rows written by SQL, the KYC
 * trigger, or another instance — so another machine's slip shows up within a couple of seconds
 * instead of at the next minute's sync.
 */
@Injectable()
export class SyncHub implements OnModuleDestroy {
  static readonly TICK_MS = 2_000;

  private readonly waiting = new Map<string, Set<Waiter>>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly db: Db) {}

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const set of this.waiting.values()) for (const w of set) w.finish(null);
    this.waiting.clear();
  }

  async counters(shopId: string): Promise<Counters> {
    const row = await this.db.withShop(shopId, async (tx) => (await tx.query<{ last_seq: string; reset_seq: string }>(
      `SELECT last_seq, reset_seq FROM shop_counters WHERE shop_id = $1`, [shopId])).rows[0]);
    return { lastSeq: Number(row?.last_seq ?? 0), resetSeq: Number(row?.reset_seq ?? 0) };
  }

  /** Answers as soon as the feed has a row after [after], or after [seconds] with what it has. */
  async wait(shopId: string, after: number, seconds: number): Promise<Counters> {
    const now = await this.counters(shopId);
    if (now.lastSeq > after || seconds <= 0) return now;
    const c = await new Promise<Counters | null>((resolve) => {
      let set = this.waiting.get(shopId);
      if (!set) this.waiting.set(shopId, (set = new Set()));
      const w: Waiter = {
        after,
        finish: (c) => {
          clearTimeout(timeout);
          set!.delete(w);
          if (set!.size === 0) this.waiting.delete(shopId);
          resolve(c);
        },
      };
      const timeout = setTimeout(() => w.finish(null), seconds * 1000);
      set.add(w);
      this.timer ??= setInterval(() => void this.tick(), SyncHub.TICK_MS);
    });
    return c ?? this.counters(shopId);
  }

  /** The shop's feed may have moved: answer whoever is now behind it. */
  async wake(shopId: string): Promise<void> {
    if (!this.waiting.has(shopId)) return;
    const c = await this.counters(shopId);
    for (const w of [...(this.waiting.get(shopId) ?? [])]) if (c.lastSeq > w.after) w.finish(c);
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.waiting.size === 0) {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        return;
      }
      for (const shopId of [...this.waiting.keys()]) await this.wake(shopId).catch(() => undefined);
    } finally {
      this.ticking = false;
    }
  }
}
