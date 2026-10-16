import { Controller, Get, Injectable, NotFoundException, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { parse } from '../common/validate';
import { Db } from '../db/db.service';

const FLAVORS = ['pos', 'daybook', 'tally'] as const;
type Flavor = (typeof FLAVORS)[number];

const LatestQuery = z.object({ flavor: z.enum(FLAVORS) });
const ApkQuery = z.object({ flavor: z.enum(FLAVORS), versionCode: z.coerce.number().int().positive() });

type Release = { version_code: number; version_name: string; sha256: string; size_bytes: number; notes: string; created_at: Date };

/** What a download is saved as, so Downloads shows which app and version it is. */
const FILES: Record<Flavor, { name: (v: string) => string; type: string }> = {
  pos: { name: (v) => `MandiPlus-POS-${v}.apk`, type: 'application/vnd.android.package-archive' },
  daybook: { name: (v) => `MandiPlus-Daybook-${v}.apk`, type: 'application/vnd.android.package-archive' },
  // The Tally connector for a shop's Windows laptop: exe + setup files, zipped.
  tally: { name: (v) => `MandiTally-${v}-windows.zip`, type: 'application/zip' },
};

/** Published APKs, read the same way by the terminals updating themselves and by the download page. */
@Injectable()
export class ReleasesStore {
  /** The newest APK per flavor. Every device fetches the same one, so it is read once. */
  private readonly cache = new Map<string, { versionCode: number; apk: Buffer }>();

  constructor(private readonly db: Db) {}

  latest(flavor: Flavor) {
    return this.db.one<Release>(
      `SELECT version_code, version_name, sha256, size_bytes, notes, created_at FROM app_releases
       WHERE flavor = $1 ORDER BY version_code DESC LIMIT 1`,
      [flavor],
    );
  }

  async apk(flavor: Flavor, versionCode: number) {
    let hit = this.cache.get(flavor);
    if (hit?.versionCode !== versionCode) {
      const row = await this.db.one<{ apk: Buffer }>(
        `SELECT apk FROM app_releases WHERE flavor = $1 AND version_code = $2`, [flavor, versionCode]);
      if (!row) throw new NotFoundException('Yeh version nahi mila');
      hit = { versionCode, apk: row.apk };
      // Keep only the newest: an older one is asked for only by a device mid-download during a publish.
      if (versionCode > (this.cache.get(flavor)?.versionCode ?? 0)) this.cache.set(flavor, hit);
    }
    return hit.apk;
  }
}

const describe = (r: Release) => ({
  versionCode: r.version_code, versionName: r.version_name, sha256: r.sha256, sizeBytes: r.size_bytes, notes: r.notes,
});

/**
 * The app updating itself. A terminal asks for the newest build of its flavor, and when it is
 * newer than what it runs, downloads it, checks the hash and hands it to Android to install.
 * Logged-in devices only; a new phone gets its first copy from the public download below.
 */
@Controller('v1/app')
@UseGuards(AuthGuard)
export class ReleasesController {
  constructor(private readonly store: ReleasesStore) {}

  /** The newest release of the flavor, or `{ release: null }` when none is published. */
  @Get('latest')
  async latest(@Query() query: unknown) {
    const { flavor } = parse(LatestQuery, query);
    const r = await this.store.latest(flavor);
    return { release: r ? describe(r) : null };
  }

  @Get('apk')
  async apk(@Query() query: unknown, @Res() res: Response) {
    const { flavor, versionCode } = parse(ApkQuery, query);
    const apk = await this.store.apk(flavor, versionCode);
    res.status(200).set({
      'Content-Type': FILES[flavor].type,
      'Content-Length': String(apk.length),
      'Cache-Control': 'private, max-age=31536000, immutable',
    }).end(apk);
  }
}

/**
 * The download page on mandiplus.com/pos-app. It shows whatever release.sh published last and
 * links to a URL that always serves the newest build, so a release needs no change to the site.
 * The app itself is useless without an OTP login, so the APK being public gives nothing away.
 */
@Controller('v1/public/app')
export class PublicReleasesController {
  constructor(private readonly store: ReleasesStore) {}

  /** The newest release of every flavor, with when it went out. */
  @Get()
  async releases(@Res({ passthrough: true }) res: Response) {
    const [pos, daybook, tally] = await Promise.all(FLAVORS.map((f) => this.store.latest(f)));
    res.set('Cache-Control', 'public, max-age=60');
    const shown = (r: Release | null) => (r ? { ...describe(r), publishedAt: r.created_at.toISOString() } : null);
    return { pos: shown(pos), daybook: shown(daybook), tally: shown(tally) };
  }

  /** The newest APK of the flavor, saved under a name that says what it is. */
  @Get('download')
  async download(@Query() query: unknown, @Res() res: Response) {
    const { flavor } = parse(LatestQuery, query);
    const r = await this.store.latest(flavor);
    if (!r) throw new NotFoundException('Abhi koi version publish nahi hua');
    const apk = await this.store.apk(flavor, r.version_code);
    res.status(200).set({
      'Content-Type': FILES[flavor].type,
      'Content-Length': String(apk.length),
      'Content-Disposition': `attachment; filename="${FILES[flavor].name(r.version_name)}"`,
      // The same URL serves the next release the moment it is published.
      'Cache-Control': 'no-cache',
      'X-App-Version': r.version_name,
    }).end(apk);
  }
}
