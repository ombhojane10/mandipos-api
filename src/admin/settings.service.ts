import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../db/db.service';

/**
 * The shop's own settings, as the app's Settings screen edits them (AccountsService.setSlipCode,
 * setShopPhone, setLedgerDetails…): the same columns, so every terminal picks a change up on its
 * next /v1/me. Written here directly because the portal's viewer is an owner or a MandiPlus admin,
 * not a terminal of the shop.
 */
/** branch, phone and pan are what a bank jama parchi needs besides the account itself. */
export type BankAccount = { holder: string; bank: string; ifsc: string; account: string; branch?: string; phone?: string; pan?: string };
export type ShopSettings = {
  name: string; mandi: string; shopNo: string; phad: string; gstin: string; commodity: string;
  phone: string; dispatchPhone: string; slipCode: string; slipLimitPaise: number; udhaarRates: boolean; udhaarAlerts: boolean;
  address: string; bankAccounts: BankAccount[]; printerHost: string; printerDots: number;
  /** The old software's Company Master: website only, never on /v1/me. */
  licenceNo: string; companyCode: string; contactPerson: string; email: string;
};

const COLUMNS: Record<Exclude<keyof ShopSettings, 'commodity'>, string> = {
  name: 'name', mandi: 'mandi', shopNo: 'shop_no', phad: 'phad', gstin: 'gstin',
  phone: 'phone', dispatchPhone: 'dispatch_phone', slipCode: 'slip_code', slipLimitPaise: 'slip_limit_paise',
  udhaarRates: 'udhaar_rates', udhaarAlerts: 'udhaar_alerts', address: 'address', bankAccounts: 'bank_accounts',
  printerHost: 'printer_host', printerDots: 'printer_dots',
  licenceNo: 'licence_no', companyCode: 'company_code', contactPerson: 'contact_person', email: 'email',
};

@Injectable()
export class SettingsService {
  constructor(private readonly db: Db) {}

  async get(shopId: string): Promise<ShopSettings> {
    const r = (await this.db.one<{
      name: string; mandi: string; shop_no: string; phad: string | null; gstin: string; commodity: string; phone: string | null; dispatch_phone: string | null;
      slip_code: string | null; slip_limit_paise: string | null; udhaar_rates: boolean | null; udhaar_alerts: boolean | null; address: string | null;
      bank_accounts: BankAccount[] | null; printer_host: string | null; printer_dots: number | null;
      licence_no: string; company_code: string; contact_person: string; email: string;
    }>(`SELECT name, mandi, shop_no, phad, gstin, commodity, phone, dispatch_phone, slip_code, slip_limit_paise, udhaar_rates, udhaar_alerts,
               address, bank_accounts, printer_host, printer_dots, licence_no, company_code, contact_person, email FROM shops WHERE id = $1`, [shopId]))!;
    return {
      name: r.name, mandi: r.mandi ?? '', shopNo: r.shop_no ?? '', phad: r.phad ?? '', gstin: r.gstin ?? '', commodity: r.commodity ?? 'nariyal',
      phone: r.phone ?? '', dispatchPhone: r.dispatch_phone ?? '', slipCode: r.slip_code ?? '', slipLimitPaise: Number(r.slip_limit_paise ?? 0),
      udhaarRates: r.udhaar_rates ?? false, udhaarAlerts: r.udhaar_alerts ?? false, address: r.address ?? '',
      bankAccounts: r.bank_accounts ?? [], printerHost: r.printer_host ?? '', printerDots: r.printer_dots ?? 576,
      licenceNo: r.licence_no ?? '', companyCode: r.company_code ?? '', contactPerson: r.contact_person ?? '', email: r.email ?? '',
    };
  }

  /** Only the fields sent change; a bank row with nothing typed in it is left out, as the app does. */
  async save(shopId: string, patch: Partial<Omit<ShopSettings, 'commodity'>>) {
    if (patch.name !== undefined && !patch.name.trim()) throw new BadRequestException('Firm ka naam daalein');
    if (patch.email && !z.email().safeParse(patch.email).success) throw new BadRequestException('Email sahi likhein');
    if (patch.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(patch.gstin)) throw new BadRequestException('GSTIN 15 akshar ka hota hai (jaise 07ABCDE1234F1Z5)');
    const sets: string[] = [];
    const values: unknown[] = [shopId];
    for (const [key, col] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) {
      if (patch[key] === undefined) continue;
      let v: unknown = patch[key];
      if (key === 'bankAccounts') v = JSON.stringify((v as BankAccount[]).filter((a) => a.holder || a.bank || a.ifsc || a.account));
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    }
    if (sets.length) await this.db.query(`UPDATE shops SET ${sets.join(', ')} WHERE id = $1`, values);
    return this.get(shopId);
  }
}
