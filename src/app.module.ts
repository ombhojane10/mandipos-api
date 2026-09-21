import { Module } from '@nestjs/common';
import { AccountsService } from './auth/accounts.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { OtpService } from './auth/otp.service';
import { TokensService } from './auth/tokens.service';
import { Db } from './db/db.service';
import { HealthController } from './health/health.controller';
import { ShopsController } from './shops/shops.controller';
import { SyncController } from './sync/sync.controller';
import { SyncService } from './sync/sync.service';

@Module({
  controllers: [HealthController, AuthController, ShopsController, SyncController],
  providers: [Db, OtpService, TokensService, AccountsService, AuthGuard, SyncService],
})
export class AppModule {}
