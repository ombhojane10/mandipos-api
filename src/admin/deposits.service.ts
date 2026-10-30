import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Db, Tx } from '../db/db.service';
import { uuidv7 } from '../common/uuid';
import { EntriesService } from './entries.service';
import { SettingsService, type BankAccount } from './settings.service';
import { BALANCES, n } from './sql';

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** The notes a bank slip counts cash in, largest first; 'coins' is loose change by value. */
export const NOTES = ['2000', '500', '200', '100', '50', '20', '10', 'coins'] as const;
type Notes = Partial<Record<(typeof NOTES)[number], number>>;
const cashOf = (notes: Notes) => NOTES.reduce((t, k) => t + (k === 'coins' ? Math.round(notes[k] ?? 0) : Math.round(notes[k] ?? 0) * Number(k) * 100), 0);

export type DepositAccount = { holder: string; bank: string; branch: string; ifsc: string; account: string; phone: string; pan: string };
export type ChequeInput = {
  id?: string; buyerId?: string | null; drawer?: string; bank?: string; branch?: string; city?: string;
  chequeNo?: string; chequeDate?: string | null; amountPaise: number;
  /** 'new': write a raseed for it in the grahak's khata; a collection id: the raseed already written; null: neither. */
  raseed?: 'new' | string | null;
};
export type DepositInput = { day?: string; account: DepositAccount; notes: Notes; note?: string; cheques: ChequeInput[]; daybook?: boolean; saveAccount?: boolean };

type ChequeRow = {
  id: string; slip_id: string; pos: number; buyer_id: string | null; drawer: string; bank: string; branch: string; city: string; cheque_no: string;
  cheque_date: string | null; amount_paise: string; collection_id: string | null; made_raseed: boolean; status: 'pending' | 'cleared' | 'bounced';
  status_on: string | null; bounce_reason: string; charges_paise: string; name: string | null; receipt_no: number | null; raseed_live: boolean | null;
};

/**
 * Bank jama parchi: the slip a shop fills to put its grahak's cheques (and cash) into its bank,
 * kept here so it is never lost. A cheque from a grahak can also put the money in their khata
 * (a raseed in bank mode, numbered like any other); a bounce takes that raseed back out. The
 * cash, when wanted, is a Day Book 'bank_jama' line (galla → bank). Website only.
 */
@Injectable()
export class DepositsService {
  constructor(private readonly db: Db, private readonly entries: EntriesService, private readonly settings: SettingsService) {}

  /** What a new slip starts from: the shop's accounts (with name, phone and PAN to fill), the next number. */
  async form(shopId: string) {
    const s = await this.settings.get(shopId);
    const pan = (a: BankAccount) => a.pan || (s.gstin.length === 15 ? s.gstin.slice(2, 12) : '');
    const accounts: DepositAccount[] = s.bankAccounts.map((a) => ({
      holder: a.holder || s.name, bank: a.bank, branch: a.branch ?? '', ifsc: a.ifsc, account: a.account, phone: a.phone || s.phone, pan: pan(a),
    }));
    return this.db.withShop(shopId, async (tx) => {
      const nextNo = await this.nextNo(tx);
      // Banks written before, so a cheque's bank fills from a few letters.
      const banks = (await tx.query<{ bank: string; branch: string; city: string }>(
        `SELECT DISTINCT ON (upper(bank), upper(branch)) bank, branch, city FROM deposit_cheques WHERE bank <> '' ORDER BY upper(bank), upper(branch), created_at DESC LIMIT 200`)).rows;
      return { shopName: s.name, shopPhone: s.phone, accounts, nextNo, banks, today: istToday() };
    });
  }

  /** For a cheque line: the grahak's baaki, the bank they last paid from, and bank raseeds not yet on any slip. */
  async grahak(shopId: string, buyerId: string) {
    return this.db.withShop(shopId, async (tx) => {
      const b = (await tx.query<{ name: string; bal: string | null }>(
        `SELECT g.name, x.bal FROM buyers g LEFT JOIN (${BALANCES}) x ON x.buyer_id = g.id WHERE g.id = $1`, [buyerId])).rows[0];
      if (!b) throw new NotFoundException('Grahak nahi mila');
      const last = (await tx.query<{ drawer: string; bank: string; branch: string; city: string }>(
        `SELECT drawer, bank, branch, city FROM deposit_cheques WHERE buyer_id = $1 ORDER BY created_at DESC LIMIT 1`, [buyerId])).rows[0] ?? null;
      const raseeds = (await tx.query<{ id: string; receipt_no: number | null; amount: string; ref: string; day: string }>(
        `SELECT MIN(c.id::text)::uuid AS id, c.receipt_no, SUM(c.upi_paise) AS amount, MAX(c.payment_ref) AS ref, MAX(c.business_date)::text AS day
         FROM collections c
         WHERE c.buyer_id = $1 AND c.upi_paise > 0 AND c.business_date > current_date - 60
           AND NOT EXISTS (SELECT 1 FROM collection_voids v WHERE v.collection_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM deposit_cheques d JOIN deposit_slips s ON s.id = d.slip_id
                           WHERE s.voided_at IS NULL AND d.collection_id IN (SELECT c2.id FROM collections c2 WHERE c2.buyer_id = c.buyer_id AND c2.receipt_no = c.receipt_no))
         GROUP BY c.receipt_no, c.created_at ORDER BY c.created_at DESC LIMIT 5`, [buyerId])).rows;
      return {
        name: b.name, balancePaise: n(b.bal), last,
        raseeds: raseeds.map((r) => ({ id: r.id, receiptNo: r.receipt_no, amountPaise: n(r.amount), ref: r.ref, day: r.day })),
      };
    });
  }

  /** Slips of [from, to], newest first, with what became of their cheques. */
  async list(shopId: string, from: string, to: string) {
    return this.db.withShop(shopId, async (tx) => {
      const slips = (await tx.query<{ id: string; slip_no: number; day: string; account: DepositAccount; cash_paise: string; note: string; voided_at: Date | null }>(
        `SELECT id, slip_no, day::text AS day, account, cash_paise, note, voided_at FROM deposit_slips
         WHERE day BETWEEN $1 AND $2 ORDER BY day DESC, slip_no DESC`, [from, to])).rows;
      const cheques = slips.length ? await this.chequeRows(tx, `d.slip_id = ANY($1)`, [slips.map((s) => s.id)]) : [];
      const rows = slips.map((s) => {
        const mine = cheques.filter((c) => c.slipId === s.id);
        const chequePaise = mine.reduce((t, c) => t + c.amountPaise, 0);
        return {
          id: s.id, slipNo: s.slip_no, day: s.day, bank: s.account.bank, account: s.account.account, note: s.note, voided: !!s.voided_at,
          cashPaise: n(s.cash_paise), chequePaise, totalPaise: n(s.cash_paise) + chequePaise,
          cheques: mine.length, pending: mine.filter((c) => c.status === 'pending').length,
          cleared: mine.filter((c) => c.status === 'cleared').length, bounced: mine.filter((c) => c.status === 'bounced').length,
          names: [...new Set(mine.map((c) => c.name || c.drawer).filter(Boolean))],
        };
      });
      const live = rows.filter((r) => !r.voided);
      return { slips: rows, totals: {
        cashPaise: live.reduce((t, r) => t + r.cashPaise, 0), chequePaise: live.reduce((t, r) => t + r.chequePaise, 0),
        pendingPaise: cheques.filter((c) => c.status === 'pending' && live.some((r) => r.id === c.slipId)).reduce((t, c) => t + c.amountPaise, 0),
        bouncedPaise: cheques.filter((c) => c.status === 'bounced' && live.some((r) => r.id === c.slipId)).reduce((t, c) => t + c.amountPaise, 0),
      } };
    });
  }

  /** Every cheque on a live slip, newest first: the cheque register. */
  async cheques(shopId: string, status: string, q: string) {
    return this.db.withShop(shopId, async (tx) => {
      const rows = await this.chequeRows(tx, `s.voided_at IS NULL AND ($1 = '' OR d.status = $1)`, [status], 500);
      const f = q.trim().toLowerCase();
      return { cheques: f ? rows.filter((c) => [c.name, c.drawer, c.chequeNo, c.bank].some((x) => (x ?? '').toLowerCase().includes(f))) : rows };
    });
  }

  async one(shopId: string, slipId: string) {
    return this.db.withShop(shopId, async (tx) => {
      const s = (await tx.query<{ id: string; slip_no: number; day: string; account: DepositAccount; notes: Notes; cash_paise: string; note: string; daybook_id: string | null; created_by: string; created_at: Date; voided_at: Date | null }>(
        `SELECT id, slip_no, day::text AS day, account, notes, cash_paise, note, daybook_id, created_by, created_at, voided_at FROM deposit_slips WHERE id = $1`, [slipId])).rows[0];
      if (!s) throw new NotFoundException('Parchi nahi mili');
      const cheques = await this.chequeRows(tx, `d.slip_id = $1`, [slipId]);
      const chequePaise = cheques.reduce((t, c) => t + c.amountPaise, 0);
      return {
        id: s.id, slipNo: s.slip_no, day: s.day, account: s.account, notes: s.notes, cashPaise: n(s.cash_paise), chequePaise,
        totalPaise: n(s.cash_paise) + chequePaise, note: s.note, daybook: !!s.daybook_id, by: s.created_by, at: s.created_at.toISOString(),
        voided: !!s.voided_at, cheques,
      };
    });
  }

  /** A new slip, or [slipId] written again. Cheques keep their ids (and status) across an edit. */
  async save(phone: string, shopId: string, slipId: string | null, input: DepositInput) {
    const day = input.day && /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : istToday();
    const cash = cashOf(input.notes);
    const lines = input.cheques.filter((c) => c.amountPaise > 0);
    if (!lines.length && cash <= 0) throw new BadRequestException('Cheque ya cash daalein');
    if (!input.account.account.trim()) throw new BadRequestException('Account number daalein');
    // A bank turns cash of ₹50,000 and above away without the depositor's PAN.
    if (cash >= 5_000_000 && !/^[A-Z]{5}\d{4}[A-Z]$/.test(input.account.pan.trim().toUpperCase())) throw new BadRequestException('₹50,000 se zyada cash ke liye PAN zaroori hai');
    for (const c of lines) if (c.raseed === 'new' && !c.buyerId) throw new BadRequestException('Khate mein jama ke liye grahak chunein');
    const account: DepositAccount = {
      holder: input.account.holder.trim().toUpperCase(), bank: input.account.bank.trim().toUpperCase(), branch: input.account.branch.trim().toUpperCase(),
      ifsc: input.account.ifsc.trim().toUpperCase(), account: input.account.account.replace(/\s+/g, ''), phone: input.account.phone.replace(/\D/g, '').slice(-10),
      pan: input.account.pan.trim().toUpperCase(),
    };
    const label = `${account.bank} ${account.account.slice(-4)}`.trim();

    const old = slipId ? await this.one(shopId, slipId) : null;
    if (old?.voided) throw new UnprocessableEntityException('Yeh parchi hata di gayi hai');
    const oldById = new Map((old?.cheques ?? []).map((c) => [c.id, c]));
    for (const c of lines) {
      const was = c.id ? oldById.get(c.id) : undefined;
      if (was && was.status === 'bounced' && (was.amountPaise !== c.amountPaise || (was.buyerId ?? null) !== (c.buyerId ?? null))) {
        throw new UnprocessableEntityException(`Cheque ${was.chequeNo} bounce ho chuka — use badal nahi sakte`);
      }
    }

    // Raseeds: kept as they are unless the grahak or amount changed; new ones written for 'new'.
    const raseedFor = new Map<number, { id: string | null; made: boolean }>();
    for (const [i, c] of lines.entries()) {
      const was = c.id ? oldById.get(c.id) : undefined;
      const same = was && was.collectionId && (was.buyerId ?? null) === (c.buyerId ?? null) && was.amountPaise === c.amountPaise;
      if (was?.collectionId && was.madeRaseed && !same && was.raseedLive) await this.entries.voidCollection(phone, shopId, was.collectionId);
      if (same && (c.raseed === 'new' || c.raseed === was!.collectionId)) { raseedFor.set(i, { id: was!.collectionId, made: was!.madeRaseed }); continue; }
      if (c.raseed === 'new') {
        const r = await this.entries.vasooli(phone, shopId, {
          buyerId: c.buyerId!, cashPaise: 0, upiPaise: c.amountPaise, upiBank: label, paymentRef: `CHQ ${(c.chequeNo ?? '').trim()}`.trim(), date: day,
        });
        raseedFor.set(i, { id: r.id, made: true });
      } else if (c.raseed && isUuid(c.raseed)) raseedFor.set(i, { id: c.raseed, made: false });
      else raseedFor.set(i, { id: null, made: false });
    }
    // Cheques dropped in an edit take the raseed they made with them.
    const keep = new Set(lines.map((c) => c.id).filter(Boolean));
    for (const c of old?.cheques ?? []) {
      if (!keep.has(c.id) && c.collectionId && c.madeRaseed && c.raseedLive) await this.entries.voidCollection(phone, shopId, c.collectionId);
    }

    // The cash's Day Book line, written again whenever the cash or the day changes.
    let daybookId: string | null = old ? (await this.daybookOf(shopId, old.id)) : null;
    const wantBook = input.daybook !== false && cash > 0;
    if (daybookId && (!wantBook || old!.cashPaise !== cash || old!.day !== day)) { await this.entries.hideDaybook(phone, shopId, daybookId); daybookId = null; }
    if (wantBook && !daybookId) {
      daybookId = (await this.entries.daybook(phone, shopId, {
        direction: 'out', category: 'bank_jama', mode: 'cash', amountPaise: cash, party: label, note: 'Bank jama parchi', date: day,
      })).id;
    }

    if (input.saveAccount) await this.rememberAccount(shopId, account);

    return this.db.withShop(shopId, async (tx) => {
      const id = old?.id ?? uuidv7();
      if (old) {
        await tx.query(`UPDATE deposit_slips SET day = $2, account = $3, notes = $4, cash_paise = $5, note = $6, daybook_id = $7, updated_at = now() WHERE id = $1`,
          [id, day, account, cleanNotes(input.notes), cash, (input.note ?? '').trim().slice(0, 200), daybookId]);
        await tx.query(`DELETE FROM deposit_cheques WHERE slip_id = $1 AND NOT (id = ANY($2))`, [id, [...keep]]);
      } else {
        await tx.query(`INSERT INTO deposit_slips (id, shop_id, slip_no, day, account, notes, cash_paise, note, daybook_id, created_by)
                        VALUES ($1, current_setting('app.shop_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, await this.nextNo(tx), day, account, cleanNotes(input.notes), cash, (input.note ?? '').trim().slice(0, 200), daybookId, phone]);
      }
      for (const [i, c] of lines.entries()) {
        const r = raseedFor.get(i)!;
        const cols = [c.buyerId ?? null, up(c.drawer, 120), up(c.bank, 80), up(c.branch, 80), up(c.city, 60), (c.chequeNo ?? '').replace(/\s+/g, '').slice(0, 12),
          c.chequeDate && /^\d{4}-\d{2}-\d{2}$/.test(c.chequeDate) ? c.chequeDate : null, c.amountPaise, r.id, r.made, i];
        if (c.id && oldById.has(c.id)) {
          await tx.query(`UPDATE deposit_cheques SET buyer_id = $2, drawer = $3, bank = $4, branch = $5, city = $6, cheque_no = $7, cheque_date = $8,
                            amount_paise = $9, collection_id = $10, made_raseed = $11, pos = $12 WHERE id = $1`, [c.id, ...cols]);
        } else {
          await tx.query(`INSERT INTO deposit_cheques (id, shop_id, slip_id, buyer_id, drawer, bank, branch, city, cheque_no, cheque_date, amount_paise, collection_id, made_raseed, pos)
                          VALUES ($1, current_setting('app.shop_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, [uuidv7(), id, ...cols]);
        }
      }
      return { id, slipNo: old?.slipNo ?? (await tx.query<{ slip_no: number }>(`SELECT slip_no FROM deposit_slips WHERE id = $1`, [id])).rows[0].slip_no };
    });
  }

  /** Hatayein: the slip is kept but struck out; the raseeds it wrote and its Day Book line go with it. */
  async remove(phone: string, shopId: string, slipId: string) {
    const s = await this.one(shopId, slipId);
    if (s.voided) return { id: slipId };
    for (const c of s.cheques) if (c.collectionId && c.madeRaseed && c.raseedLive) await this.entries.voidCollection(phone, shopId, c.collectionId);
    const book = await this.daybookOf(shopId, slipId);
    if (book) await this.entries.hideDaybook(phone, shopId, book);
    await this.db.withShop(shopId, (tx) => tx.query(`UPDATE deposit_slips SET voided_at = now(), updated_at = now() WHERE id = $1`, [slipId]));
    return { id: slipId };
  }

  /**
   * A cheque cleared, or bounced (with the bank's reason and charges): a bounce takes its raseed
   * out of the grahak's khata again, so the udhaar stands as before. A bounce is final — a cheque
   * given again goes on a new slip.
   */
  async status(phone: string, shopId: string, chequeId: string, input: { status: 'pending' | 'cleared' | 'bounced'; on?: string; reason?: string; chargesPaise?: number }) {
    const c = await this.db.withShop(shopId, async (tx) => (await this.chequeRows(tx, `d.id = $1`, [chequeId]))[0]);
    if (!c) throw new NotFoundException('Cheque nahi mila');
    if (c.status === 'bounced') throw new UnprocessableEntityException('Bounce hua cheque wapas nahi badalta — naye parchi par daalein');
    if (input.status === 'bounced' && c.collectionId && c.raseedLive) await this.entries.voidCollection(phone, shopId, c.collectionId);
    await this.db.withShop(shopId, (tx) => tx.query(
      `UPDATE deposit_cheques SET status = $2, status_on = $3, bounce_reason = $4, charges_paise = $5 WHERE id = $1`,
      [chequeId, input.status, input.status === 'pending' ? null : (input.on && /^\d{4}-\d{2}-\d{2}$/.test(input.on) ? input.on : istToday()),
        input.status === 'bounced' ? (input.reason ?? '').trim().slice(0, 120) : '', input.status === 'bounced' ? Math.max(0, Math.round(input.chargesPaise ?? 0)) : 0]));
    return { id: chequeId, status: input.status };
  }

  private async chequeRows(tx: Tx, where: string, params: unknown[], limit = 1000) {
    const rows = (await tx.query<ChequeRow & { slip_no: number; day: string }>(
      `SELECT d.*, d.cheque_date::text AS cheque_date, d.status_on::text AS status_on, g.name, s.slip_no, s.day::text AS day,
              (SELECT MIN(c.receipt_no) FROM collections c WHERE c.id = d.collection_id) AS receipt_no,
              (SELECT NOT EXISTS (SELECT 1 FROM collection_voids v WHERE v.collection_id = d.collection_id)) AS raseed_live
       FROM deposit_cheques d JOIN deposit_slips s ON s.id = d.slip_id LEFT JOIN buyers g ON g.id = d.buyer_id
       WHERE ${where} ORDER BY s.day DESC, s.slip_no DESC, d.pos LIMIT ${limit}`, params)).rows;
    return rows.map((r) => ({
      id: r.id, slipId: r.slip_id, slipNo: r.slip_no, day: r.day, buyerId: r.buyer_id, name: r.name, drawer: r.drawer, bank: r.bank, branch: r.branch,
      city: r.city, chequeNo: r.cheque_no, chequeDate: r.cheque_date, amountPaise: n(r.amount_paise), collectionId: r.collection_id, madeRaseed: r.made_raseed,
      receiptNo: r.receipt_no, raseedLive: r.collection_id ? !!r.raseed_live : false, status: r.status, statusOn: r.status_on,
      bounceReason: r.bounce_reason, chargesPaise: n(r.charges_paise),
    }));
  }

  private async daybookOf(shopId: string, slipId: string) {
    return this.db.withShop(shopId, async (tx) => (await tx.query<{ daybook_id: string | null }>(`SELECT daybook_id FROM deposit_slips WHERE id = $1`, [slipId])).rows[0]?.daybook_id ?? null);
  }

  private async nextNo(tx: Tx) {
    return n((await tx.query<{ m: string | null }>(`SELECT MAX(slip_no) AS m FROM deposit_slips`)).rows[0].m) + 1;
  }

  /** A new account on a slip becomes one of the shop's accounts (Settings), or fills in what it was missing. */
  private async rememberAccount(shopId: string, a: DepositAccount) {
    const s = await this.settings.get(shopId);
    const list = [...s.bankAccounts];
    const at = list.findIndex((x) => x.account.replace(/\s+/g, '') === a.account);
    const row: BankAccount = { holder: a.holder, bank: a.bank, ifsc: a.ifsc, account: a.account, branch: a.branch, phone: a.phone, pan: a.pan };
    if (at >= 0) list[at] = { ...list[at], ...Object.fromEntries(Object.entries(row).filter(([, v]) => v)) } as BankAccount;
    else if (list.length < 4) list.push(row);
    else return;
    await this.settings.save(shopId, { bankAccounts: list });
  }
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const up = (v: string | undefined, max: number) => (v ?? '').trim().toUpperCase().slice(0, max);
const cleanNotes = (notes: Notes) => Object.fromEntries(NOTES.map((k) => [k, Math.max(0, Math.round(notes[k] ?? 0))]).filter(([, v]) => (v as number) > 0));
