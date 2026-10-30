import { Injectable, NotFoundException } from '@nestjs/common';
import { Db, Tx } from '../db/db.service';
import { nameKey } from './reports.service';
import { BALANCES, n } from './sql';

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** The financial year a date falls in, by its starting year: 2026-04-01 … 2027-03-31 → 2026. */
export function fyOf(day: string): number {
  const [y, m] = day.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}
export const fyRange = (fy: number) => ({ from: `${fy}-04-01`, to: `${fy + 1}-03-31`, label: `${fy}-${String((fy + 1) % 100).padStart(2, '0')}` });

type Master = { id: string; name: string; phone: string; code: string; area: string; opening: number; openingOn: string | null };
type Move = { at: string; kind: 'opening' | 'beejak' | 'payment'; id: string; title: string; detail: string; creditPaise: number; debitPaise: number };

/**
 * Supplier creditors (angoor): what the shop owes each supplier, by financial year. The master
 * (supplier_phones) holds a manual code, area and an opening balance on a date; a saved beejak's
 * net is owed to its party; a supplier payment pays it. A year's opening is everything before
 * 1 April — last year's closing carried forward, never reset.
 */
@Injectable()
export class CreditorsService {
  constructor(private readonly db: Db) {}

  /** Every supplier with its moves (opening, beejaks, payments); the Trial Balance reads it as on a date. */
  async books(tx: Tx) {
    const masters = (await tx.query<{ id: string; name: string; phone: string; code: string; area: string; opening_paise: string; opening_on: string | null }>(
      `SELECT id, name, phone, code, area, opening_paise, opening_on::text AS opening_on FROM supplier_phones ORDER BY name`)).rows
      .map((r): Master => ({ id: r.id, name: r.name, phone: r.phone, code: r.code, area: r.area, opening: n(r.opening_paise), openingOn: r.opening_on }));
    const beejaks = (await tx.query<{ id: string; beejak_no: number; party: string; gaadi: string; day: string; net_paise: string; boxes: number }>(
      `SELECT id, beejak_no, TRIM(party) AS party, gaadi, day::text AS day, net_paise, boxes FROM beejaks WHERE TRIM(party) <> ''`)).rows;
    const payments = (await tx.query<{ id: string; party: string; amount: string; mode: string; note: string; day: string }>(
      `SELECT id, TRIM(party_name) AS party, amount_paise AS amount, mode, note, business_date::text AS day FROM daybook_entries
       WHERE category = 'supplier' AND direction = 'out' AND hidden = false AND TRIM(party_name) <> ''`)).rows;
    const gaadis = (await tx.query<{ supplier: string }>(`SELECT DISTINCT TRIM(supplier) AS supplier FROM trucks WHERE TRIM(supplier) <> ''`)).rows;

    // One supplier per folded name: the master's spelling first, then what the gaadis and payments say.
    const people = new Map<string, { key: string; name: string; master: Master | null; moves: Move[] }>();
    const get = (name: string) => {
      const key = nameKey(name);
      if (!key) return null;
      let p = people.get(key);
      if (!p) { p = { key, name: name.trim(), master: null, moves: [] }; people.set(key, p); }
      return p;
    };
    for (const m of masters) {
      const p = get(m.name);
      if (!p) continue;
      p.master = m; p.name = m.name;
      if (m.opening) p.moves.push({ at: m.openingOn ?? '0001-01-01', kind: 'opening', id: m.id, title: 'Opening balance', detail: '', creditPaise: Math.max(0, m.opening), debitPaise: Math.max(0, -m.opening) });
    }
    for (const g of gaadis) get(g.supplier);
    for (const b of beejaks) get(b.party)?.moves.push({ at: b.day, kind: 'beejak', id: b.id, title: `Beejak #${b.beejak_no}`, detail: `Gaadi ${b.gaadi} · ${b.boxes} box`, creditPaise: n(b.net_paise), debitPaise: 0 });
    for (const x of payments) get(x.party)?.moves.push({ at: x.day, kind: 'payment', id: x.id, title: 'Payment', detail: [x.mode, x.note].filter(Boolean).join(' · '), creditPaise: 0, debitPaise: n(x.amount) });
    return [...people.values()];
  }

  /** Every supplier for the year: opening (carried), beejaks credited, paid, closing. */
  async list(shopId: string, fy?: number) {
    const year = fy ?? fyOf(istToday());
    const { from, to, label } = fyRange(year);
    return this.db.withShop(shopId, async (tx) => {
      const rows = (await this.books(tx)).map((p) => {
        const before = p.moves.filter((m) => m.at < from), inYear = p.moves.filter((m) => m.at >= from && m.at <= to);
        const opening = before.reduce((t, m) => t + m.creditPaise - m.debitPaise, 0);
        const credit = inYear.reduce((t, m) => t + m.creditPaise, 0), paid = inYear.reduce((t, m) => t + m.debitPaise, 0);
        return { key: p.key, id: p.master?.id ?? null, name: p.name, code: p.master?.code ?? '', area: p.master?.area ?? '', phone: p.master?.phone ?? '',
          masterOpeningPaise: p.master?.opening ?? 0, masterOpeningOn: p.master?.openingOn ?? null,
          openingPaise: opening, creditPaise: credit, paidPaise: paid, balancePaise: opening + credit - paid,
          beejaks: inYear.filter((m) => m.kind === 'beejak').length };
      }).sort((a, b) => (a.code || '~').localeCompare(b.code || '~', 'en', { numeric: true }) || a.name.localeCompare(b.name));
      const sum = (k: 'openingPaise' | 'creditPaise' | 'paidPaise' | 'balancePaise') => rows.reduce((t, r) => t + r[k], 0);
      return { fy: year, label, from, to, rows,
        totals: { openingPaise: sum('openingPaise'), creditPaise: sum('creditPaise'), paidPaise: sum('paidPaise'), balancePaise: sum('balancePaise') } };
    });
  }

  /** One supplier's year: brought forward, then each beejak and payment with a running balance. */
  async khata(shopId: string, key: string, fy?: number) {
    const year = fy ?? fyOf(istToday());
    const { from, to, label } = fyRange(year);
    return this.db.withShop(shopId, async (tx) => {
      const p = (await this.books(tx)).find((x) => x.key === key);
      if (!p) throw new NotFoundException('Supplier nahi mila');
      const opening = p.moves.filter((m) => m.at < from).reduce((t, m) => t + m.creditPaise - m.debitPaise, 0);
      let bal = opening;
      const lines = p.moves.filter((m) => m.at >= from && m.at <= to)
        .sort((a, b) => a.at.localeCompare(b.at) || (a.kind === 'opening' ? -1 : b.kind === 'opening' ? 1 : 0))
        .map((m) => { bal += m.creditPaise - m.debitPaise; return { ...m, date: m.at, balancePaise: bal }; });
      const years = [...new Set(p.moves.map((m) => fyOf(m.at === '0001-01-01' ? from : m.at)).concat(year))].sort((a, b) => b - a);
      return { key: p.key, name: p.name, master: p.master, fy: year, label, from, to, openingPaise: opening, lines, closingPaise: bal, years };
    });
  }

  /** Laddan parties (buyers of kind 'laddan') with every master field and what they owe now. */
  async laddan(shopId: string, q = '') {
    return this.db.withShop(shopId, async (tx) => {
      const like = `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = (await tx.query<{ id: string; name: string; code: string; phone: string; address: string; city: string; district: string; state: string; contact_person: string; email: string; area: string; bank_details: string; hidden: boolean; bal: string | null }>(
        `SELECT g.id, g.name, g.code, g.phone, g.address, g.city, g.district, g.state, g.contact_person, g.email, g.area, g.bank_details, g.hidden, x.bal
         FROM buyers g LEFT JOIN (${BALANCES}) x ON x.buyer_id = g.id
         WHERE g.kind = 'laddan' AND ($1 = '' OR g.name ILIKE $2 OR g.code ILIKE $2 OR g.city ILIKE $2 OR g.phone LIKE $2)
         ORDER BY g.hidden, g.name LIMIT 500`, [q.trim(), like])).rows;
      return { parties: rows.map((r) => ({
        id: r.id, name: r.name, code: r.code, phone: r.phone, address: r.address, city: r.city, district: r.district, state: r.state,
        contactPerson: r.contact_person, email: r.email, area: r.area, bankDetails: r.bank_details, hidden: r.hidden, balancePaise: n(r.bal),
      })) };
    });
  }
}
