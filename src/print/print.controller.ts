import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthGuard, Me } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { parse } from '../common/validate';
import { PrintService } from './print.service';

const Width = z.coerce.number().int().min(200).max(1280);
const SendBody = z.object({
  title: z.string().trim().max(120).default(''),
  image: z.string().min(8).max(600_000),
  widthDots: Width,
});
const NextQuery = z.object({
  name: z.string().trim().max(60).default(''),
  widthDots: Width.default(384),
  wait: z.coerce.number().int().min(0).max(25).default(20),
  roll: z.enum(['TERMINAL', 'SEZNIK', 'WIFI', '']).default(''),
});
const DoneBody = z.object({ ok: z.boolean(), error: z.string().max(500).default('') });
const Id = z.uuid();

/** Slips sent from anywhere, printed by the shop's station in the office. */
@Controller('v1/print')
@UseGuards(AuthGuard)
export class PrintController {
  constructor(private readonly print: PrintService) {}

  /** Any device: send a slip image to the shop's printer. */
  @Post('jobs')
  send(@Me() p: Principal, @Body() body: unknown) {
    const b = parse(SendBody, body);
    return this.print.send(p, b.title, b.image, b.widthDots);
  }

  @Get('jobs')
  async recent(@Me() p: Principal) {
    return { jobs: await this.print.recent(p) };
  }

  @Get('jobs/:id')
  one(@Me() p: Principal, @Param('id') id: string) {
    return this.print.one(p, parse(Id, id));
  }

  @Post('jobs/:id/retry')
  @HttpCode(200)
  retry(@Me() p: Principal, @Param('id') id: string) {
    return this.print.retry(p, parse(Id, id));
  }

  /** Is there a station on right now, and how wide is its printer. */
  @Get('station')
  async station(@Me() p: Principal) {
    return { station: await this.print.station(p) };
  }

  /** This device stops being the shop's station. */
  @Delete('station')
  @HttpCode(204)
  async leave(@Me() p: Principal) {
    await this.print.leave(p);
  }

  /** Station long-poll: 200 with a slip to print, or 204 when none came within `wait` seconds. */
  @Get('next')
  async next(@Me() p: Principal, @Query() query: unknown, @Res() res: Response) {
    const q = parse(NextQuery, query);
    // The request's own 'close' fires as soon as its (empty) body is read; the response's
    // fires only when the station hangs up before we answer — then a slip must not be claimed.
    let gone = false;
    res.on('close', () => { if (!res.writableFinished) gone = true; });
    const job = await this.print.next(p, q.name, q.widthDots, q.wait, () => gone, q.roll);
    if (gone) return;
    if (job) res.status(200).json(job);
    else res.status(204).end();
  }

  @Post('jobs/:id/done')
  @HttpCode(204)
  async done(@Me() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(DoneBody, body);
    await this.print.done(p, parse(Id, id), b.ok, b.error);
  }
}
