import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AccountsService } from '../auth/accounts.service';
import { Principal } from '../auth/tokens.service';
import { Db } from '../db/db.service';
import { requireCheekuTx } from './cheeku';

/**
 * Cheeku's own shop switches, copied from the grapes ones (AccountsService.setApmc,
 * setSlipWhatsapp, setStaffBackupCode): APMC on new slips, each slip to the grahak on WhatsApp,
 * and the backup code for the accountant lock. Also removes a gaadi entered by mistake or as a test.
 * Admin only, cheeku shops only.
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

  /**
   * Admin: deletes a gaadi on every machine, for one entered by mistake or as a test. This only
   * works while nothing uses the gaadi (no slip, set-aside, beejak, store entry...). A gaadi that
   * has been used stays in the books and can be closed (band) instead. See migration 074.
   */
  async deleteTruck(p: Principal, truckId: string) {
    return this.db.tx(async (tx) => {
      await this.accounts.requireAdmin(tx, p);
      await requireCheekuTx(tx, p.shopId!);
      const r = (await tx.query<{ r: string }>(`SELECT cheeku_delete_truck($1, $2, $3) AS r`, [p.shopId, truckId, p.deviceId])).rows[0].r;
      if (r === 'not_found') throw new NotFoundException('Gaadi nahi mili');
      if (r === 'used') throw new UnprocessableEntityException('Is gaadi ki parchi ya hisaab ban chuka hai, ise hataya nahi ja sakta. Ise band kar dein.');
      if (r !== 'deleted') throw new UnprocessableEntityException('Yeh dukaan cheeku ki nahi hai');
      return { deleted: true };
    });
  }
}
