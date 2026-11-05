import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Headers, Param, Post, Query } from '@nestjs/common';
import { DatabaseError } from 'pg';
import { z } from 'zod';
import { parse } from '../common/validate';
import { Db } from '../db/db.service';
import { readApk } from './apk';

/** The release key every POS update is signed with: a build signed any other way can't update the machines. */
const RELEASE_CERT = '163e9678060ab2f2a12e20f02db0072fd30c7686906735eacf11df2efff4da36';
/** The flavors that can be published this way, and the app each must be. */
const APPS = {
  pos: { packageName: 'com.mandiplus.pos.uat', cert: RELEASE_CERT },
  daybook: { packageName: 'com.mandiplus.daybook', cert: RELEASE_CERT },
} as const;

const Flavor = z.enum(['pos', 'daybook']);
const Notes = z.object({ notes: z.string().max(500).default('') });

/**
 * release.sh's publish, for the team: the signed APK is uploaded with the person's own release
 * token, and every logged-in machine updates itself to it (ReleasesController). No Render
 * access and no owner database login are needed. The build is checked from the file itself:
 * signed with the release key, the right app, newer than what is out. The token is checked,
 * and the build written, by publish_app_release() (migration 077), which records who it was.
 */
@Controller('v1/releases')
export class ReleasePublishController {
  constructor(private readonly db: Db) {}

  @Post(':flavor')
  async publish(@Param('flavor') flavorParam: string, @Headers('x-release-token') token: string | undefined,
    @Query() query: unknown, @Body() body: unknown) {
    const flavor = parse(Flavor, flavorParam);
    const { notes } = parse(Notes, query);
    if (!token || token.length < 32 || token.length > 200) throw new ForbiddenException('Release token missing');
    const ok = (await this.db.pool.query<{ ok: boolean }>(`SELECT release_token_ok($1, $2) AS ok`, [token, flavor])).rows[0].ok;
    if (!ok) throw new ForbiddenException('Release token not allowed');
    if (!Buffer.isBuffer(body) || body.length < 1000) throw new BadRequestException('Send the APK as the request body (Content-Type: application/vnd.android.package-archive)');

    let info;
    try { info = readApk(body); } catch (e) { throw new BadRequestException(`Not an APK: ${(e as Error).message}`); }
    const app = APPS[flavor];
    if (info.packageName !== app.packageName) throw new BadRequestException(`This is ${info.packageName}, not the ${flavor} app (${app.packageName})`);
    if (!info.certSha256.includes(app.cert)) {
      throw new BadRequestException('Not signed with the release key: machines would refuse it as an update. Build with keystore.properties (assemble…Release).');
    }
    if (!info.versionCode || !info.versionName) throw new BadRequestException('The APK has no versionCode / versionName');

    try {
      const { rows } = await this.db.pool.query<{ who: string }>(
        `SELECT publish_app_release($1, $2, $3, $4, $5, $6) AS who`, [token, flavor, info.versionCode, info.versionName, body, notes]);
      return { published: true, flavor, versionCode: info.versionCode, versionName: info.versionName, sizeBytes: body.length, by: rows[0].who };
    } catch (e) {
      if (e instanceof DatabaseError && e.code === '42501') throw new ForbiddenException('Release token not allowed');
      if (e instanceof DatabaseError && e.code === '23514') throw new ConflictException(`${e.message}. Bump versionCode in app/build.gradle.kts.`);
      throw e;
    }
  }
}
