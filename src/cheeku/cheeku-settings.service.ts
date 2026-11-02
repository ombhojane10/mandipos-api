import { Injectable } from '@nestjs/common';
import { AccountsService } from '../auth/accounts.service';
import { Principal } from '../auth/tokens.service';
import { Db } from '../db/db.service';
import { requireCheekuTx } from './cheeku';

/**
 * Cheeku's own shop switches, copied from the grapes ones (AccountsService.setApmc,
 * setSlipWhatsapp, setStaffBackupCode): APMC on new slips, each slip to the grahak on WhatsApp,
 * and the backup code for the accountant lock. Admin only, cheeku shops only.
 */
@Injectable()
export class CheekuSettingsService {
  constructor(private readonly db: Db, private readonly accounts: AccountsService) {}

  /** Admin: whether new slips carry the 1% APMC. */
  async setApmc(p: Principal, on: boolean) {
    return this.db.tx(async (tx) => {
      await this.accounts.requireAdmin(tx, p);
      await requireCheekuTx(tx, p.shopId!);
      await tx.query(`UPDATE shops SET apmc_on = $2 WHERE id = $1`, [p.shopId, on]);
    });
  }

  /** Admin: whether each slip goes to the grahak on WhatsApp as it is saved. */
  async setSlipWhatsapp(p: Principal, on: boolean) {
    return this.db.tx(async (tx) => {
      await this.accounts.requireAdmin(tx, p);
      await requireCheekuTx(tx, p.shopId!);
      await tx.query(`UPDATE shops SET slip_whatsapp = $2 WHERE id = $1`, [p.shopId, on]);
    });
  }

  /** Admin: the code that opens the accountant lock when an accountant's own one is forgotten. */
  async setStaffBackupCode(p: Principal, code: string) {
    return this.db.tx(async (tx) => {
      await this.accounts.requireAdmin(tx, p);
      await requireCheekuTx(tx, p.shopId!);
      await tx.query(`UPDATE shops SET staff_backup_code = $2 WHERE id = $1`, [p.shopId, code]);
    });
  }
}
