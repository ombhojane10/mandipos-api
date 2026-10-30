import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '../common/uuid';
import { Db, Tx } from '../db/db.service';
import type { PushItem } from '../sync/sync.service';
import { fyOf, fyRange } from './creditors.service';
import { EntriesService } from './entries.service';
import { nameKey } from './reports.service';
import { LIVE_BILLS, LIVE_COLS, OPENING_NOTES, n, supplierJvs } from './sql';

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const up = (s: string | undefined) => (s ?? '').trim().toUpperCase();
const MOBILE_OR_BLANK = /^([6-9]\d{9})?$/;

export type HeadType = 'expense' | 'income' | 'asset' | 'liability';
const MODE_BOOK: Record<string, string> = { cash: 'Galla', office: 'Office', upi: 'Bank', bank: 'Bank' };

/** The Day Book's own heads (the app's categories): listed read-only beside the shop's own. */
export const BUILTIN_HEADS: { key: string; name: string; type: HeadType }[] = [
  { key: 'kharcha', name: 'Kharcha', type: 'expense' },
  { key: 'mazdoori', name: 'Mazdoori', type: 'expense' },
  { key: 'bhada', name: 'Bhada', type: 'expense' },
  { key: 'kiraya', name: 'Kiraya', type: 'expense' },
  { key: 'tankhwah', name: 'Tankhwah', type: 'expense' },
  { key: 'bill', name: 'Bijli-pani', type: 'expense' },
  { key: 'aur_gaya', name: 'Aur gaya', type: 'expense' },
  { key: 'aur_aaya', name: 'Aur aaya', type: 'income' },
  { key: 'committee_di', name: 'Committee di', type: 'asset' },
  { key: 'committee_mili', name: 'Committee mili', type: 'asset' },
  { key: 'udhaar_diya', name: 'Udhaar diya', type: 'asset' },
  { key: 'udhaar_wapas', name: 'Udhaar wapas', type: 'asset' },
  { key: 'handover', name: 'Malik ko diya', type: 'asset' },
  { key: 'float', name: 'Galla ko diya', type: 'asset' },
  { key: 'bank_jama', name: 'Bank jama', type: 'asset' },
  { key: 'bank_nikala', name: 'Bank se nikala', type: 'asset' },
  { key: 'supplier', name: 'Supplier payment', type: 'liability' },
];

/** The built-in category a custom head's Day Book line is written as, by direction. */
export function headCategory(type: HeadType, direction: 'in' | 'out'): string {
  if (direction === 'in') return 'aur_aaya';
  return type === 'expense' ? 'kharcha' : 'aur_gaya';
}
const headCategories = (type: HeadType) =>
  type === 'expense' ? ['kharcha'] : type === 'income' ? ['aur_aaya'] : ['aur_gaya', 'aur_aaya'];
/** Debit-side heads carry their opening as +, credit-side as −. */
const openingSign = (type: HeadType) => (type === 'expense' || type === 'asset' ? 1 : -1);

export { OPENING_NOTES };

type CustomHead = { id: string; name: string; type: HeadType; opening_paise: string; opening_on: string | null; hidden: boolean };
type DayLine = { id: string; direction: 'in' | 'out'; category: string; party: string; amount: string; day: string; note: string; mode: string };

export type ProductInput = { id?: string; name?: string; hidden?: boolean; shelfDays?: number; groupId?: string | null };
export type AreaInput = { id?: string; name: string; code?: string; from?: string };
export type StoreInput = { id?: string; name: string; address?: string; contactPerson?: string; phone?: string };
export type HeadInput = { id?: string; name: string; type: HeadType; openingPaise?: number; openingOn?: string | null };

/**
 * The old software's Masters: products (the synced brands) and their groups, areas, cold stores,
 * the shop's own ledger heads, and every opening balance on one page. Products, area renames and
 * openings are pushed as the website's terminal (EntriesService.pushAsWeb) so the machines get
 * them; groups, areas, stores and heads are website-only tables (065).
 */
@Injectable()
export class MastersService {
  constructor(private readonly db: Db, private readonly entries: EntriesService) {}

  // ---------------------------------------------------------------- Product Master (brands) and groups

  /** Every product with its group and what it sold this financial year; the groups with their totals. */
  async products(shopId: string, fy?: number) {
    const year = fy ?? fyOf(istToday());
    const { from, to, label } = fyRange(year);
    return this.db.withShop(shopId, async (tx) => {
      const rows = (await tx.query<{ id: string; name: string; sort_order: number; hidden: boolean; shelf_days: number; group_id: string | null; nags: string | null; amount: string | null }>(
        `SELECT b.id, b.name, b.sort_order, b.hidden, b.shelf_days, bg.group_id, s.nags, s.amount
         FROM brands b LEFT JOIN brand_groups bg ON bg.brand_id = b.id
         LEFT JOIN (SELECT l.brand_id, SUM(l.qty) AS nags, SUM(l.qty::bigint * l.rate_paise) AS amount
                    FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id WHERE lb.business_date BETWEEN $1 AND $2 GROUP BY l.brand_id) s ON s.brand_id = b.id
         ORDER BY b.hidden, b.sort_order, b.name`, [from, to])).rows;
      const groups = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM product_groups ORDER BY name`)).rows;
      const products = rows.map((r) => ({
        id: r.id, name: r.name, sortOrder: r.sort_order, hidden: r.hidden, shelfDays: r.shelf_days, groupId: r.group_id,
        nags: n(r.nags), amountPaise: n(r.amount),
      }));
      return {
        fy: year, label, products,
        groups: groups.map((g) => {
          const mine = products.filter((p) => p.groupId === g.id);
          return { id: g.id, name: g.name, products: mine.length, nags: mine.reduce((t, p) => t + p.nags, 0), amountPaise: mine.reduce((t, p) => t + p.amountPaise, 0) };
        }),
      };
    });
  }

  /** Adds or changes a product (pushed to the terminals as a brand) and sets its group. */
  async saveProduct(phone: string, shopId: string, input: ProductInput) {
    const caps = await this.entries.capsNames(shopId);
    const typed = input.name === undefined ? undefined : caps ? up(input.name) : input.name.trim();
    if (!input.id && !typed) throw new BadRequestException('Naam daalein');
    const pre = await this.db.withShop(shopId, async (tx) => {
      const all = (await tx.query<{ id: string; name: string; sort_order: number; hidden: boolean; shelf_days: number; created_at: Date }>(
        `SELECT id, name, sort_order, hidden, shelf_days, created_at FROM brands`)).rows;
      const mine = input.id ? all.find((b) => b.id === input.id) : undefined;
      if (input.id && !mine) throw new NotFoundException('Maal nahi mila');
      const name = typed ?? mine!.name;
      if (all.some((b) => b.id !== mine?.id && nameKey(b.name) === nameKey(name))) throw new ConflictException(`${name} pehle se hai`);
      if (input.groupId && !(await tx.query(`SELECT 1 FROM product_groups WHERE id = $1`, [input.groupId])).rowCount) throw new BadRequestException('Group nahi mila');
      return { mine, name, next: Math.min(999, all.filter((b) => b.sort_order < 999).reduce((m, b) => Math.max(m, b.sort_order), 0) + 1) };
    });
    const name = pre.name;
    const now = new Date().toISOString();
    const id = pre.mine?.id ?? uuidv7();
    const hidden = input.hidden ?? pre.mine?.hidden ?? false, shelf = input.shelfDays ?? pre.mine?.shelf_days ?? 7;
    // Only the group changed: nothing for the terminals.
    if (!pre.mine || pre.mine.name !== name || pre.mine.hidden !== hidden || pre.mine.shelf_days !== shelf) {
      await this.entries.pushAsWeb(phone, shopId, [{ table: 'brands', txn: uuidv7(), row: {
        id, created_at: pre.mine ? pre.mine.created_at.toISOString() : now, updated_at: now, name,
        sort_order: pre.mine?.sort_order ?? pre.next, hidden, shelf_days: shelf,
      } }]);
    }
    if (input.groupId !== undefined) await this.setGroup(shopId, id, input.groupId);
    return { id, name };
  }

  private async setGroup(shopId: string, brandId: string, groupId: string | null) {
    await this.db.withShop(shopId, async (tx) => {
      if (!groupId) await tx.query(`DELETE FROM brand_groups WHERE brand_id = $1`, [brandId]);
      else await tx.query(
        `INSERT INTO brand_groups (brand_id, shop_id, group_id) VALUES ($1, $2, $3) ON CONFLICT (brand_id) DO UPDATE SET group_id = EXCLUDED.group_id`,
        [brandId, shopId, groupId]);
    });
  }

  /** The products in this order, top first: each moved one is pushed with its new sort_order. */
  async orderProducts(phone: string, shopId: string, ids: string[]) {
    const rows = await this.db.withShop(shopId, async (tx) => (await tx.query<{ id: string; name: string; sort_order: number; hidden: boolean; shelf_days: number; created_at: Date }>(
      `SELECT id, name, sort_order, hidden, shelf_days, created_at FROM brands WHERE id = ANY($1::uuid[])`, [ids])).rows);
    const now = new Date().toISOString();
    const items: PushItem[] = [];
    ids.forEach((id, i) => {
      const b = rows.find((r) => r.id === id);
      if (!b || b.sort_order === i + 1) return;
      items.push({ table: 'brands', txn: uuidv7(), row: {
        id, created_at: b.created_at.toISOString(), updated_at: now, name: b.name, sort_order: i + 1, hidden: b.hidden, shelf_days: b.shelf_days,
      } });
    });
    await this.entries.pushAsWeb(phone, shopId, items);
    return { moved: items.length };
  }

  async saveGroup(shopId: string, input: { id?: string; name: string }) {
    const name = (await this.entries.capsNames(shopId)) ? up(input.name) : input.name.trim();
    if (!name) throw new BadRequestException('Naam daalein');
    return this.db.withShop(shopId, async (tx) => {
      if ((await tx.query(`SELECT 1 FROM product_groups WHERE upper(trim(name)) = upper($1) AND id <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000')`, [name, input.id ?? null])).rowCount) {
        throw new ConflictException(`${name} pehle se hai`);
      }
      if (input.id) {
        if (!(await tx.query(`UPDATE product_groups SET name = $2, updated_at = now() WHERE id = $1`, [input.id, name])).rowCount) throw new NotFoundException('Group nahi mila');
        return { id: input.id, name };
      }
      const id = uuidv7();
      await tx.query(`INSERT INTO product_groups (id, shop_id, name) VALUES ($1, $2, $3)`, [id, shopId, name]);
      return { id, name };
    });
  }

  /** A group gone: its products stay, without a group. */
  async deleteGroup(shopId: string, id: string) {
    await this.db.withShop(shopId, async (tx) => {
      if (!(await tx.query(`DELETE FROM product_groups WHERE id = $1`, [id])).rowCount) throw new NotFoundException('Group nahi mila');
    });
    return { id };
  }

  // ---------------------------------------------------------------- Area Master

  /**
   * The master's areas and every area already written on a grahak or supplier, with how many of
   * each are in it. One written but not in the master comes with id null, so nothing is hidden.
   */
  async areas(shopId: string) {
    return this.db.withShop(shopId, async (tx) => {
      const master = (await tx.query<{ id: string; name: string; code: string }>(`SELECT id, name, code FROM areas`)).rows;
      const buyers = (await tx.query<{ a: string; c: string }>(`SELECT upper(trim(area)) AS a, COUNT(*) AS c FROM buyers WHERE trim(area) <> '' AND hidden = false GROUP BY 1`)).rows;
      const suppliers = (await tx.query<{ a: string; c: string }>(`SELECT upper(trim(area)) AS a, COUNT(*) AS c FROM supplier_phones WHERE trim(area) <> '' GROUP BY 1`)).rows;
      const out = new Map<string, { id: string | null; name: string; code: string; grahak: number; suppliers: number }>();
      for (const m of master) out.set(up(m.name), { id: m.id, name: m.name, code: m.code, grahak: 0, suppliers: 0 });
      const at = (a: string) => out.get(a) ?? out.set(a, { id: null, name: a, code: '', grahak: 0, suppliers: 0 }).get(a)!;
      for (const b of buyers) at(b.a).grahak = n(b.c);
      for (const s of suppliers) at(s.a).suppliers = n(s.c);
      // Coded areas first, by code; then the rest by name.
      return { areas: [...out.values()].sort((a, b) => Number(!a.code) - Number(!b.code) || a.code.localeCompare(b.code, 'en', { numeric: true }) || a.name.localeCompare(b.name)) };
    });
  }

  /**
   * Adds or changes an area. A rename (or a written-only area taken into the master under a new
   * name, [from]) rewrites it on every grahak and supplier in it, pushed so the machines follow.
   */
  async saveArea(phone: string, shopId: string, input: AreaInput) {
    const name = up(input.name);
    const code = up(input.code);
    if (!name) throw new BadRequestException('Area ka naam daalein');
    const pre = await this.db.withShop(shopId, async (tx) => {
      const mine = input.id ? (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM areas WHERE id = $1`, [input.id])).rows[0] : undefined;
      if (input.id && !mine) throw new NotFoundException('Area nahi mila');
      const clash = (await tx.query<{ id: string; name: string; code: string }>(`SELECT id, name, code FROM areas WHERE id <> COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000')`, [input.id ?? null])).rows;
      if (clash.some((a) => up(a.name) === name)) throw new ConflictException(`${name} pehle se hai`);
      if (code && clash.some((a) => a.code === code)) throw new ConflictException(`Code ${code} pehle se ${clash.find((a) => a.code === code)!.name} ka hai`);
      const old = up(mine?.name ?? input.from);
      if (!old || old === name) return { old: null, buyers: [], suppliers: [] };
      const buyers = (await tx.query<{ id: string; created_at: Date; name: string; phone: string; kind: string; credit_limit_paise: string; vehicle: string; address: string; destination: string; hidden: boolean }>(
        `SELECT id, created_at, name, phone, kind, credit_limit_paise, vehicle, address, destination, hidden FROM buyers WHERE upper(trim(area)) = $1`, [old])).rows;
      const suppliers = (await tx.query<{ id: string; created_at: Date; name: string; phone: string }>(
        `SELECT id, created_at, name, phone FROM supplier_phones WHERE upper(trim(area)) = $1`, [old])).rows;
      return { old, buyers, suppliers };
    });
    const now = new Date().toISOString();
    // The rows first: if the push is refused, the master keeps the old name with them.
    await this.entries.pushAsWeb(phone, shopId, [
      ...pre.buyers.map((g): PushItem => ({ table: 'buyers', txn: uuidv7(), row: {
        id: g.id, created_at: g.created_at.toISOString(), updated_at: now, name: g.name, phone: g.phone, kind: g.kind,
        credit_limit_paise: n(g.credit_limit_paise), vehicle: g.vehicle, address: g.address, destination: g.destination, hidden: g.hidden, area: name,
      } })),
      ...pre.suppliers.map((s): PushItem => ({ table: 'supplier_phones', txn: uuidv7(), row: {
        id: s.id, created_at: s.created_at.toISOString(), updated_at: now, name: s.name, phone: s.phone, area: name,
      } })),
    ]);
    return this.db.withShop(shopId, async (tx) => {
      if (input.id) {
        await tx.query(`UPDATE areas SET name = $2, code = $3, updated_at = now() WHERE id = $1`, [input.id, name, code]);
        return { id: input.id, name, code, renamed: pre.buyers.length + pre.suppliers.length };
      }
      const id = uuidv7();
      await tx.query(`INSERT INTO areas (id, shop_id, name, code) VALUES ($1, $2, $3, $4)`, [id, shopId, name, code]);
      return { id, name, code, renamed: pre.buyers.length + pre.suppliers.length };
    });
  }

  /** Only an empty area goes; one with grahak or suppliers in it is refused. */
  async deleteArea(shopId: string, id: string) {
    return this.db.withShop(shopId, async (tx) => {
      const a = (await tx.query<{ name: string }>(`SELECT name FROM areas WHERE id = $1`, [id])).rows[0];
      if (!a) throw new NotFoundException('Area nahi mila');
      const used = (await tx.query<{ c: string }>(
        `SELECT (SELECT COUNT(*) FROM buyers WHERE upper(trim(area)) = upper(trim($1)) AND hidden = false)
              + (SELECT COUNT(*) FROM supplier_phones WHERE upper(trim(area)) = upper(trim($1))) AS c`, [a.name])).rows[0];
      if (n(used.c)) throw new ConflictException(`${a.name} mein ${n(used.c)} grahak/supplier hain`);
      await tx.query(`DELETE FROM areas WHERE id = $1`, [id]);
      return { id };
    });
  }

  // ---------------------------------------------------------------- Store Master (cold stores)

  async stores(shopId: string) {
    return this.db.withShop(shopId, async (tx) => ({
      stores: (await tx.query<{ id: string; name: string; address: string; contact_person: string; phone: string; hidden: boolean }>(
        `SELECT id, name, address, contact_person, phone, hidden FROM stores ORDER BY hidden, name`)).rows
        .map((s) => ({ id: s.id, name: s.name, address: s.address, contactPerson: s.contact_person, phone: s.phone, hidden: s.hidden })),
    }));
  }

  async saveStore(shopId: string, input: StoreInput) {
    const caps = await this.entries.capsNames(shopId);
    const fix = (s: string | undefined) => (caps ? up(s) : (s ?? '').trim());
    const name = fix(input.name);
    if (!name) throw new BadRequestException('Store ka naam daalein');
    const mobile = (input.phone ?? '').trim();
    if (!MOBILE_OR_BLANK.test(mobile)) throw new BadRequestException('Mobile number 10 ank ka hona chahiye');
    return this.db.withShop(shopId, async (tx) => {
      if ((await tx.query(`SELECT 1 FROM stores WHERE upper(trim(name)) = upper($1) AND id <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000')`, [name, input.id ?? null])).rowCount) {
        throw new ConflictException(`${name} pehle se hai`);
      }
      const vals = [name, fix(input.address), fix(input.contactPerson), mobile];
      if (input.id) {
        if (!(await tx.query(`UPDATE stores SET name = $2, address = $3, contact_person = $4, phone = $5, updated_at = now() WHERE id = $1`, [input.id, ...vals])).rowCount) {
          throw new NotFoundException('Store nahi mila');
        }
        return { id: input.id, name };
      }
      const id = uuidv7();
      await tx.query(`INSERT INTO stores (id, shop_id, name, address, contact_person, phone) VALUES ($1, $2, $3, $4, $5, $6)`, [id, shopId, ...vals]);
      return { id, name };
    });
  }

  /** Hidden, never deleted: store entries point at it. One still holding boxes stays, so none get stuck. */
  async hideStore(shopId: string, id: string, hidden: boolean) {
    return this.db.withShop(shopId, async (tx) => {
      if (hidden) {
        const s = (await tx.query<{ name: string; boxes: string }>(
          `SELECT s.name, (SELECT COALESCE(SUM(CASE WHEN m.dir = 'in' THEN m.boxes ELSE -m.boxes END), 0) FROM store_moves m
                           WHERE m.store_id = s.id AND m.voided_at IS NULL) AS boxes FROM stores s WHERE s.id = $1`, [id])).rows[0];
        if (s && n(s.boxes) > 0) throw new ConflictException(`${s.name} mein abhi ${n(s.boxes)} box hain: pehle Store Out karein`);
      }
      if (!(await tx.query(`UPDATE stores SET hidden = $2, updated_at = now() WHERE id = $1`, [id, hidden])).rowCount) throw new NotFoundException('Store nahi mila');
      return { id, hidden };
    });
  }

  // ---------------------------------------------------------------- General Ledger heads

  private async dayLines(tx: Tx): Promise<DayLine[]> {
    return (await tx.query<DayLine>(
      `SELECT id, direction, category, upper(trim(party_name)) AS party, amount_paise AS amount, business_date::text AS day, note, mode
       FROM daybook_entries WHERE hidden = false`)).rows;
  }

  /** Which head a Day Book line is booked to: a custom head by its name, else its own category. */
  private claim(custom: CustomHead[]) {
    const byName = new Map(custom.map((h) => [up(h.name), h]));
    return (l: DayLine): string => {
      const h = byName.get(l.party);
      return h && headCategories(h.type).includes(l.category) ? h.id : `b:${l.category}`;
    };
  }

  /** Every head, built-in first, with opening, what came in and went out this year, and closing (Dr +, Cr −). */
  async heads(shopId: string, fy?: number) {
    const year = fy ?? fyOf(istToday());
    const { from, to, label } = fyRange(year);
    return this.db.withShop(shopId, async (tx) => {
      const custom = await this.customHeads(tx);
      const lines = await this.dayLines(tx);
      const owner = this.claim(custom);
      const sums = new Map<string, { before: number; dr: number; cr: number }>();
      for (const l of lines) {
        if (l.day > to) continue;
        const k = owner(l);
        const s = sums.get(k) ?? { before: 0, dr: 0, cr: 0 };
        const amt = n(l.amount) * (l.direction === 'out' ? 1 : -1);
        if (l.day < from) s.before += amt; else if (amt > 0) s.dr += amt; else s.cr -= amt;
        sums.set(k, s);
      }
      const row = (key: string, id: string | null, name: string, type: HeadType, builtin: boolean, opening: number, openingOn: string | null, hidden: boolean) => {
        const s = sums.get(key) ?? { before: 0, dr: 0, cr: 0 };
        const signed = opening * openingSign(type);
        const openingIn = !openingOn || openingOn < from ? signed : 0;
        const openingYear = openingOn && openingOn >= from && openingOn <= to ? signed : 0;
        const ob = s.before + openingIn;
        return { key, id, name, type, builtin, hidden, masterOpeningPaise: opening, masterOpeningOn: openingOn,
          openingPaise: ob, debitPaise: s.dr + Math.max(0, openingYear), creditPaise: s.cr + Math.max(0, -openingYear), closingPaise: ob + openingYear + s.dr - s.cr };
      };
      return {
        fy: year, label,
        heads: [
          ...BUILTIN_HEADS.map((h) => row(`b:${h.key}`, null, h.name, h.type, true, 0, null, false)),
          ...custom.map((h) => row(h.id, h.id, h.name, h.type, false, n(h.opening_paise), h.opening_on, h.hidden)),
        ],
      };
    });
  }

  private async customHeads(tx: Tx) {
    return (await tx.query<CustomHead>(`SELECT id, name, type, opening_paise, opening_on::text AS opening_on, hidden FROM ledger_heads ORDER BY hidden, name`)).rows;
  }

  /** One head's year: brought forward, each Day Book line with a running balance (Dr +), closing. */
  async headLedger(shopId: string, key: string, fy?: number) {
    const year = fy ?? fyOf(istToday());
    const { from, to, label } = fyRange(year);
    return this.db.withShop(shopId, async (tx) => {
      const custom = await this.customHeads(tx);
      const h = key.startsWith('b:') ? BUILTIN_HEADS.find((b) => `b:${b.key}` === key) : custom.find((c) => c.id === key);
      if (!h) throw new NotFoundException('Head nahi mila');
      const owner = this.claim(custom);
      const mine = (await this.dayLines(tx)).filter((l) => owner(l) === key && l.day <= to).sort((a, b) => a.day.localeCompare(b.day));
      const ch = 'id' in h ? h : null;
      const opening = ch ? n(ch.opening_paise) * openingSign(ch.type) : 0;
      const openingOn = ch?.opening_on ?? null;
      let bal = mine.filter((l) => l.day < from).reduce((t, l) => t + n(l.amount) * (l.direction === 'out' ? 1 : -1), 0) + (!openingOn || openingOn < from ? opening : 0);
      const broughtPaise = bal;
      const lines = [
        ...(openingOn && openingOn >= from && openingOn <= to && opening ? [{ id: 'opening', date: openingOn, title: 'Opening balance', detail: '', debitPaise: Math.max(0, opening), creditPaise: Math.max(0, -opening) }] : []),
        ...mine.filter((l) => l.day >= from).map((l) => ({
          id: l.id, date: l.day, title: l.party || (BUILTIN_HEADS.find((b) => b.key === l.category)?.name ?? l.category),
          // The book it came from, as the Cash/Bank Book names them; a note that only repeats the head is left out.
          detail: [MODE_BOOK[l.mode] ?? l.mode, up(l.note) === l.party ? '' : l.note].filter(Boolean).join(' · '),
          debitPaise: l.direction === 'out' ? n(l.amount) : 0, creditPaise: l.direction === 'in' ? n(l.amount) : 0,
        })),
      ].sort((a, b) => a.date.localeCompare(b.date)).map((l) => ({ ...l, balancePaise: (bal += l.debitPaise - l.creditPaise) }));
      return { key, name: h.name, type: h.type, builtin: !ch, fy: year, label, from, to, openingPaise: broughtPaise, lines, closingPaise: bal };
    });
  }

  async saveHead(shopId: string, input: HeadInput) {
    const name = (await this.entries.capsNames(shopId)) ? up(input.name) : input.name.trim();
    if (!name) throw new BadRequestException('Head ka naam daalein');
    if (BUILTIN_HEADS.some((b) => nameKey(b.name) === nameKey(name) || b.key === name.toLowerCase())) throw new ConflictException(`${name} Day Book ka apna head hai`);
    return this.db.withShop(shopId, async (tx) => {
      if ((await tx.query(`SELECT 1 FROM ledger_heads WHERE upper(trim(name)) = upper($1) AND id <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000')`, [name, input.id ?? null])).rowCount) {
        throw new ConflictException(`${name} pehle se hai`);
      }
      const vals = [name, input.type, input.openingPaise ?? 0, input.openingPaise ? input.openingOn ?? null : null];
      if (input.id) {
        const old = (await tx.query<{ name: string; type: HeadType }>(`SELECT name, type FROM ledger_heads WHERE id = $1`, [input.id])).rows[0];
        if (!old) throw new NotFoundException('Head nahi mila');
        // Its Day Book lines are found by name and category: a head in use keeps both.
        if ((up(old.name) !== up(name) || old.type !== input.type) && (await this.headUsed(tx, old.name, old.type))) {
          throw new ConflictException(`${old.name} ki entry ho chuki hai: naam ya type nahi badal sakte`);
        }
        await tx.query(`UPDATE ledger_heads SET name = $2, type = $3, opening_paise = $4, opening_on = $5, updated_at = now() WHERE id = $1`, [input.id, ...vals]);
        return { id: input.id, name };
      }
      const id = uuidv7();
      await tx.query(`INSERT INTO ledger_heads (id, shop_id, name, type, opening_paise, opening_on) VALUES ($1, $2, $3, $4, $5, $6)`, [id, shopId, ...vals]);
      return { id, name };
    });
  }

  private async headUsed(tx: Tx, name: string, type: HeadType) {
    return !!(await tx.query(`SELECT 1 FROM daybook_entries WHERE hidden = false AND upper(trim(party_name)) = upper(trim($1)) AND category = ANY($2::text[]) LIMIT 1`,
      [name, headCategories(type)])).rowCount;
  }

  /** A head with entries is hidden (its lines stay booked to it); an unused one is deleted. */
  async deleteHead(shopId: string, id: string, hidden = true) {
    return this.db.withShop(shopId, async (tx) => {
      const h = (await tx.query<{ name: string; type: HeadType }>(`SELECT name, type FROM ledger_heads WHERE id = $1`, [id])).rows[0];
      if (!h) throw new NotFoundException('Head nahi mila');
      if (!hidden) { await tx.query(`UPDATE ledger_heads SET hidden = false, updated_at = now() WHERE id = $1`, [id]); return { id, hidden: false }; }
      if (await this.headUsed(tx, h.name, h.type)) { await tx.query(`UPDATE ledger_heads SET hidden = true, updated_at = now() WHERE id = $1`, [id]); return { id, hidden: true }; }
      await tx.query(`DELETE FROM ledger_heads WHERE id = $1`, [id]);
      return { id, deleted: true };
    });
  }

  /** What a Day Book line for a custom head is written as: the nearest built-in category, the head's name as party. */
  async headEntry(shopId: string, headId: string, direction: 'in' | 'out') {
    const h = await this.db.withShop(shopId, async (tx) => (await tx.query<{ name: string; type: HeadType; hidden: boolean }>(
      `SELECT name, type, hidden FROM ledger_heads WHERE id = $1`, [headId])).rows[0]);
    if (!h || h.hidden) throw new BadRequestException('Head nahi mila');
    if (h.type === 'expense' && direction === 'in') throw new BadRequestException(`${h.name} kharcha head hai: aaya mein nahi`);
    if (h.type === 'income' && direction === 'out') throw new BadRequestException(`${h.name} aamdani head hai: kharcha mein nahi`);
    return { category: headCategory(h.type, direction), party: h.name };
  }

  // ---------------------------------------------------------------- Opening balances

  /** Every grahak's, supplier's and custom head's opening balance on one page. */
  async openings(shopId: string) {
    return this.db.withShop(shopId, async (tx) => {
      const grahak = (await tx.query<{ id: string; code: string; name: string; area: string; kind: string; hidden: boolean; opening: string | null; opening_on: string | null }>(
        `SELECT g.id, g.code, g.name, g.area, g.kind, g.hidden, o.opening, o.opening_on
         FROM buyers g LEFT JOIN (SELECT buyer_id, SUM(amount_paise) AS opening, MIN(business_date)::text AS opening_on FROM udhaar_entries
                                  WHERE note = ANY($1::text[]) GROUP BY buyer_id) o ON o.buyer_id = g.id
         WHERE g.hidden = false OR COALESCE(o.opening, 0) <> 0
         ORDER BY g.name`, [OPENING_NOTES])).rows;
      const suppliers = (await tx.query<{ id: string; code: string; name: string; area: string; opening_paise: string; opening_on: string | null }>(
        `SELECT id, code, name, area, opening_paise, opening_on::text AS opening_on FROM supplier_phones ORDER BY name`)).rows;
      // Suppliers known only from gaadis, beejaks or payments (no master row yet) are listed too, as
      // on their khata; a saved opening makes their row.
      const known = new Set(suppliers.map((s) => nameKey(s.name)));
      const onGaadis = [...(await tx.query<{ s: string }>(
        `SELECT DISTINCT s FROM (SELECT TRIM(supplier) AS s FROM trucks UNION ALL SELECT TRIM(party) FROM beejaks
           UNION ALL SELECT TRIM(party_name) FROM daybook_entries WHERE category = 'supplier' AND direction = 'out' AND hidden = false) x
         WHERE s <> '' ORDER BY 1`)).rows, ...(await supplierJvs(tx)).map((j) => ({ s: j.name.trim() }))]
        .filter((r) => { const k = nameKey(r.s); if (!k || known.has(k)) return false; known.add(k); return true; });
      const heads = await this.customHeads(tx);
      return {
        grahak: grahak.map((g) => ({ id: g.id, code: g.code, name: g.name, area: g.area, kind: g.kind, hidden: g.hidden, openingPaise: n(g.opening), openingOn: g.opening_on })),
        suppliers: [
          ...suppliers.map((s) => ({ id: s.id as string | null, code: s.code, name: s.name, area: s.area, openingPaise: n(s.opening_paise), openingOn: s.opening_on })),
          ...onGaadis.map((r) => ({ id: null, code: '', name: r.s, area: '', openingPaise: 0, openingOn: null })),
        ].sort((a, b) => a.name.localeCompare(b.name)),
        heads: heads.map((h) => ({ id: h.id, name: h.name, type: h.type, hidden: h.hidden, openingPaise: n(h.opening_paise), openingOn: h.opening_on })),
      };
    });
  }

  /**
   * A grahak's opening set to [paise]: udhaar entries can't be changed once synced, so the
   * difference is added as one more "Purana udhaar" entry (the khata shows them as one line), on
   * the date of their first one — or, the first time, on the khata's first day, so it comes
   * before everything the grahak bought or paid.
   */
  async setGrahakOpening(phone: string, shopId: string, buyerId: string, paise: number) {
    const cur = await this.db.withShop(shopId, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM buyers WHERE id = $1`, [buyerId])).rowCount) throw new NotFoundException('Grahak nahi mila');
      return (await tx.query<{ s: string | null; d: string | null; first: string | null }>(
        `SELECT SUM(amount_paise) FILTER (WHERE note = ANY($2::text[])) AS s, MIN(business_date) FILTER (WHERE note = ANY($2::text[]))::text AS d,
                LEAST(MIN(business_date), (SELECT MIN(business_date) FROM ${LIVE_BILLS} lb WHERE lb.buyer_id = $1),
                      (SELECT MIN(business_date) FROM ${LIVE_COLS} lc WHERE lc.buyer_id = $1))::text AS first
         FROM udhaar_entries WHERE buyer_id = $1`, [buyerId, OPENING_NOTES])).rows[0];
    });
    const delta = paise - n(cur.s);
    if (delta) {
      const today = istToday();
      const day = cur.d ?? (cur.first && cur.first < today ? cur.first : today);
      await this.entries.pushAsWeb(phone, shopId, [{ table: 'udhaar_entries', txn: uuidv7(), row: {
        id: uuidv7(), created_at: new Date().toISOString(), buyer_id: buyerId, amount_paise: delta, note: 'Purana udhaar', business_date: day,
      } }]);
    }
    return { id: buyerId, openingPaise: paise, changedPaise: delta };
  }

  /** A supplier's opening (what the shop owes them on a date; − = they owe us). A gaadi-only supplier gets a master row. */
  async setSupplierOpening(phone: string, shopId: string, input: { id: string | null; name: string; openingPaise: number; openingOn: string | null }) {
    const caps = await this.entries.capsNames(shopId);
    const s = await this.db.withShop(shopId, async (tx) => {
      const all = (await tx.query<{ id: string; created_at: Date; name: string; phone: string }>(`SELECT id, created_at, name, phone FROM supplier_phones`)).rows;
      const mine = input.id ? all.find((r) => r.id === input.id) : all.find((r) => nameKey(r.name) === nameKey(input.name));
      if (input.id && !mine) throw new NotFoundException('Supplier nahi mila');
      return mine ?? null;
    });
    const now = new Date().toISOString();
    const name = s?.name ?? (caps ? up(input.name) : input.name.trim());
    if (!name) throw new BadRequestException('Supplier ka naam daalein');
    const id = s?.id ?? uuidv7();
    await this.entries.pushAsWeb(phone, shopId, [{ table: 'supplier_phones', txn: uuidv7(), row: {
      id, created_at: s ? s.created_at.toISOString() : now, updated_at: now, name, phone: s?.phone ?? '',
      opening_paise: input.openingPaise, opening_on: input.openingPaise ? input.openingOn ?? istToday() : null,
    } }]);
    return { id, name, openingPaise: input.openingPaise };
  }

  async setHeadOpening(shopId: string, id: string, paise: number, on: string | null) {
    return this.db.withShop(shopId, async (tx) => {
      if (!(await tx.query(`UPDATE ledger_heads SET opening_paise = $2, opening_on = $3, updated_at = now() WHERE id = $1`, [id, paise, paise ? on : null])).rowCount) {
        throw new NotFoundException('Head nahi mila');
      }
      return { id, openingPaise: paise };
    });
  }
}
