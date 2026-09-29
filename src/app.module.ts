import { Module } from '@nestjs/common';
import { AccountsService } from './auth/accounts.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { OtpService } from './auth/otp.service';
import { TokensService } from './auth/tokens.service';
import { Db } from './db/db.service';
import { HealthController } from './health/health.controller';
import { RequestsController } from './requests/requests.controller';
import { RequestsService } from './requests/requests.service';
import { ShopsController } from './shops/shops.controller';
import { SyncController } from './sync/sync.controller';
import { SyncService } from './sync/sync.service';

@Module({
  controllers: [HealthController, AuthController, ShopsController, SyncController, RequestsController],
  providers: [Db, OtpService, TokensService, AccountsService, AuthGuard, SyncService, RequestsService],
})
export class AppModule {}
