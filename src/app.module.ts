import { Module } from '@nestjs/common';
import { UdhaarAlertsService } from './alerts/udhaar-alerts.service';
import { AccountsService } from './auth/accounts.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { OtpService } from './auth/otp.service';
import { TokensService } from './auth/tokens.service';
import { Db } from './db/db.service';
import { HealthController } from './health/health.controller';
import { PrintController } from './print/print.controller';
import { PrintService } from './print/print.service';
import { RequestsController } from './requests/requests.controller';
import { RequestsService } from './requests/requests.service';
import { ShopsController } from './shops/shops.controller';
import { SyncController } from './sync/sync.controller';
import { SyncService } from './sync/sync.service';

@Module({
  controllers: [HealthController, AuthController, ShopsController, SyncController, RequestsController, PrintController],
  providers: [Db, OtpService, TokensService, AccountsService, AuthGuard, SyncService, RequestsService, PrintService, UdhaarAlertsService],
})
export class AppModule {}
