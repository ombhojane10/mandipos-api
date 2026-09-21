import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { config } from '../config';
import { Db } from '../db/db.service';

@Controller()
export class HealthController {
  constructor(private readonly db: Db) {}

  /** Render's health check. Never touches the database, so it cannot keep Neon awake. */
  @Get('healthz')
  health() {
    return { ok: true, env: config().APP_ENV, version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? 'dev' };
  }

  /** Manual readiness probe: confirms the database answers. */
  @Get('readyz')
  async ready() {
    try {
      await this.db.query('SELECT 1');
      return { ok: true };
    } catch {
      throw new ServiceUnavailableException('database unreachable');
    }
  }
}
