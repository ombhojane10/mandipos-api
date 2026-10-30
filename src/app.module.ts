import { Module } from '@nestjs/common';
import { AdminAuthController, AdminController, AdminGuard } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { ReportsService } from './admin/reports.service';
import { EntriesService } from './admin/entries.service';
import { SettingsService } from './admin/settings.service';
import { InsightsService } from './admin/insights.service';
import { UdhaarAlertsService } from './alerts/udhaar-alerts.service';
import { RemindersService } from './alerts/reminders.service';
import { PickupNoticesService } from './alerts/pickup-notices.service';
import { CreditorsService } from './admin/creditors.service';
import { MachinesService } from './admin/machines.service';
import { DepositsService } from './admin/deposits.service';
import { MastersService } from './admin/masters.service';
import { CratesService } from './admin/crates.service';
import { ColdStoreService } from './admin/cold-store.service';
import { SlipSendsService } from './alerts/slip-sends.service';
import { SlipSendsController } from './alerts/slip-sends.controller';
import { AccountsService } from './auth/accounts.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { OtpService } from './auth/otp.service';
import { TokensService } from './auth/tokens.service';
import { Db } from './db/db.service';
import { PublicReleasesController, ReleasesController, ReleasesStore } from './app/releases.controller';
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
import { BeejaksController } from './beejaks/beejaks.controller';
import { RequestsService } from './requests/requests.service';
import { ShopsController } from './shops/shops.controller';
import { SyncController } from './sync/sync.controller';
import { SyncHub } from './sync/sync.hub';
import { SyncService } from './sync/sync.service';
import { GeminiClient } from './voice/gemini.client';
import { VoiceController } from './voice/voice.controller';
import { VoiceService } from './voice/voice.service';
import { PortalVoiceService } from './voice/portal-voice.service';
import { SheetService } from './voice/sheet.service';

@Module({
  controllers: [AdminAuthController, AdminController, HealthController, AuthController, ShopsController, SyncController, RequestsController, PrintController, PhotosController, ReleasesController, PublicReleasesController, KycController, DigilockerReturnController, VoiceController, SlipSendsController, BeejaksController],
  providers: [Db, ReleasesStore, AdminService, ReportsService, EntriesService, SettingsService, InsightsService, AdminGuard, OtpService, TokensService, AccountsService, AuthGuard, SyncService, SyncHub, RequestsService, PrintService, UdhaarAlertsService, RemindersService, PickupNoticesService, CreditorsService, MachinesService, DepositsService, MastersService, CratesService, ColdStoreService, SlipSendsService, KycService, UlipClient, DigilockerKycService, SurepassClient, SandboxDigilockerClient, GeminiClient, VoiceService, PortalVoiceService, SheetService],
})
export class AppModule {}
