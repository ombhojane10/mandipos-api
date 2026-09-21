import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import { Db } from '../db/db.service';
import { Principal, TokensService } from './tokens.service';

type AuthedRequest = Request & { principal?: Principal };

/** Bearer access token → request.principal. Rejects revoked devices immediately, not at token expiry. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly tokens: TokensService, private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException('Login zaroori hai');
    const principal = this.tokens.verifyAccess(header.slice(7));

    // One cheap query: device still active; last_seen_at written at most every 5 minutes.
    const device = await this.db.one<{ revoked_at: Date | null }>(
      `WITH seen AS (
         UPDATE devices SET last_seen_at = now()
         WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')
       )
       SELECT revoked_at FROM devices WHERE id = $1 AND user_id = $2`,
      [principal.deviceId, principal.userId],
    );
    if (!device || device.revoked_at) throw new UnauthorizedException('Yeh machine band kar di gayi hai');

    req.principal = principal;
    return true;
  }
}

export const Me = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().principal!;
});

/** For routes that only make sense once the device belongs to a shop. */
export function requireShop(p: Principal): string {
  if (!p.shopId) throw new ForbiddenException('Pehle dukaan register karein');
  return p.shopId;
}
