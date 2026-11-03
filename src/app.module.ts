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
import { ConsoleService } from './admin/console.service';
import { DepositsService } from './admin/deposits.service';
import { MastersService } from './admin/masters.service';
import { CratesService } from './admin/crates.service';
import { ColdStoreService } from './admin/cold-store.service';
import { BooksService } from './admin/books.service';
import { VouchersService } from './admin/vouchers.service';
import { InvoicesService } from './admin/invoices.service';
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
// Cheeku Fruits: its own copy of the grapes flow (src/cheeku/), registered after the shared services.
import { CheekuAdminController } from './cheeku/cheeku-admin.controller';
import { CheekuAppController } from './cheeku/cheeku-app.controller';
import { CheekuBillLinkController } from './cheeku/cheeku-bill-link.controller';
import { CheekuCommissionsService } from './cheeku/cheeku-commissions.service';
import { CheekuCreditorsService } from './cheeku/cheeku-creditors.service';
import { CheekuDeskService } from './cheeku/cheeku-desk.service';
import { CheekuEntriesService } from './cheeku/cheeku-entries.service';
import { CheekuForwardSendsService } from './cheeku/cheeku-forward-sends.service';
import { CheekuForwardService } from './cheeku/cheeku-forward.service';
import { CheekuPickupNoticesService } from './cheeku/cheeku-pickup-notices.service';
import { CheekuSettingsService } from './cheeku/cheeku-settings.service';
import { CheekuSlipSendsService } from './cheeku/cheeku-slip-sends.service';

@Module({
  controllers: [AdminAuthController, AdminController, HealthController, AuthController, ShopsController, SyncController, RequestsController, PrintController, PhotosController, ReleasesController, PublicReleasesController, KycController, DigilockerReturnController, VoiceController, SlipSendsController, BeejaksController, CheekuAppController, CheekuAdminController, CheekuBillLinkController],
  providers: [Db, ReleasesStore, AdminService, ReportsService, EntriesService, SettingsService, InsightsService, AdminGuard, OtpService, TokensService, AccountsService, AuthGuard, SyncService, SyncHub, RequestsService, PrintService, UdhaarAlertsService, RemindersService, PickupNoticesService, CreditorsService, MachinesService, ConsoleService, DepositsService, MastersService, CratesService, ColdStoreService, BooksService, VouchersService, InvoicesService, SlipSendsService, KycService, UlipClient, DigilockerKycService, SurepassClient, SandboxDigilockerClient, GeminiClient, VoiceService, PortalVoiceService, SheetService,
    CheekuEntriesService, CheekuDeskService, CheekuCreditorsService, CheekuPickupNoticesService, CheekuSlipSendsService, CheekuSettingsService, CheekuCommissionsService, CheekuForwardService, CheekuForwardSendsService],
})
export class AppModule {}
