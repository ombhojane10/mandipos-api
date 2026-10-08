import { Module } from '@nestjs/common';
import { UdhaarAlertsService } from './alerts/udhaar-alerts.service';
import { AccountsService } from './auth/accounts.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { OtpService } from './auth/otp.service';
import { TokensService } from './auth/tokens.service';
import { Db } from './db/db.service';
import { ReleasesController } from './app/releases.controller';
import { HealthController } from './health/health.controller';
import { DigilockerReturnController, KycController } from './kyc/kyc.controller';
import { DigilockerKycService } from './kyc/digilocker.service';
import { SandboxDigilockerClient } from './kyc/sandbox.client';
import { SurepassClient } from './kyc/surepass.client';
import { KycService } from './kyc/kyc.service';
import { UlipClient } from './kyc/ulip.client';
import { PrintController } from './print/print.controller';
import { PrintService } from './print/print.service';
import { PhotosController } from './shops/photos.controller';
import { RequestsController } from './requests/requests.controller';
import { RequestsService } from './requests/requests.service';
import { ShopsController } from './shops/shops.controller';
import { SyncController } from './sync/sync.controller';
import { SyncHub } from './sync/sync.hub';
import { SyncService } from './sync/sync.service';

@Module({
  controllers: [HealthController, AuthController, ShopsController, SyncController, RequestsController, PrintController, PhotosController, ReleasesController, KycController, DigilockerReturnController],
  providers: [Db, OtpService, TokensService, AccountsService, AuthGuard, SyncService, SyncHub, RequestsService, PrintService, UdhaarAlertsService, KycService, UlipClient, DigilockerKycService, SurepassClient, SandboxDigilockerClient],
})
export class AppModule {}
