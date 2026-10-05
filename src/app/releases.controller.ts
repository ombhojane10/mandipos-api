import { Controller, Get, NotFoundException, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { parse } from '../common/validate';
import { Db } from '../db/db.service';

const LatestQuery = z.object({ flavor: z.enum(['pos', 'daybook']) });
const ApkQuery = z.object({ flavor: z.enum(['pos', 'daybook']), versionCode: z.coerce.number().int().positive() });

type Release = { version_code: number; version_name: string; sha256: string; size_bytes: number; notes: string };

/**
 * The app updating itself. A terminal asks for the newest build of its flavor, and when it is
 * newer than what it runs, downloads it, checks the hash and hands it to Android to install.
 * Logged-in devices only: every terminal in the fleet is, and it keeps the APK off the open web.
 */
@Controller('v1/app')
@UseGuards(AuthGuard)
export class ReleasesController {
  /** The newest APK per flavor. Every device fetches the same one, so it is read once. */
  private readonly cache = new Map<string, { versionCode: number; apk: Buffer }>();

  constructor(private readonly db: Db) {}

  /** The newest release of the flavor, or `{ release: null }` when none is published. */
  @Get('latest')
  async latest(@Query() query: unknown) {
    const { flavor } = parse(LatestQuery, query);
    const r = await this.db.one<Release>(
      `SELECT version_code, version_name, sha256, size_bytes, notes FROM app_releases
       WHERE flavor = $1 ORDER BY version_code DESC LIMIT 1`,
      [flavor],
    );
    if (!r) return { release: null };
    return { release: { versionCode: r.version_code, versionName: r.version_name, sha256: r.sha256, sizeBytes: r.size_bytes, notes: r.notes } };
  }

  @Get('apk')
  async apk(@Query() query: unknown, @Res() res: Response) {
    const { flavor, versionCode } = parse(ApkQuery, query);
    let hit = this.cache.get(flavor);
    if (hit?.versionCode !== versionCode) {
      const row = await this.db.one<{ apk: Buffer }>(
        `SELECT apk FROM app_releases WHERE flavor = $1 AND version_code = $2`, [flavor, versionCode]);
      if (!row) throw new NotFoundException('Yeh version nahi mila');
      hit = { versionCode, apk: row.apk };
      // Keep only the newest: an older one is asked for only by a device mid-download during a publish.
      if (versionCode > (this.cache.get(flavor)?.versionCode ?? 0)) this.cache.set(flavor, hit);
    }
    res.status(200).set({
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': String(hit.apk.length),
      'Cache-Control': 'private, max-age=31536000, immutable',
    }).end(hit.apk);
  }
}
