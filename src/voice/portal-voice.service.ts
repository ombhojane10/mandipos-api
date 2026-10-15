import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AccountsService } from '../auth/accounts.service';
import { Principal } from '../auth/tokens.service';
import { AdminService } from '../admin/admin.service';
import { EntriesService } from '../admin/entries.service';
import { ReportsService } from '../admin/reports.service';
import { BALANCES, n } from '../admin/sql';
import { Db } from '../db/db.service';
import { Reply, TurnBody, VoiceService } from './voice.service';

/** What the portal sends: the recording and the moment; the books are read here, not sent. */
export const PortalTurnBody = z.object({
  audio: z.string().max(900_000).optional(),
  mime: z.enum(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/mpeg']).default('audio/webm'),
  audioMs: z.number().int().min(0).max(120_000).default(0),
  text: z.string().max(500).optional(),
  screen: z.string().max(40).default('portal'),
  draft: z.string().max(4_000).optional(),
  history: z.array(z.object({ q: z.string().max(500), a: z.string().max(500) })).max(4).optional(),
  lang: z.enum(['hinglish', 'hindi', 'english']).default('hinglish'),
});

type Buyer = { id: string; name: string; code: string; balancePaise: number };
type Truck = { id: string; number: string; supplier: string; left: number; brand: string };
type Books = { text: string; at: number; buyers: Map<string, Buyer>; trucks: Map<string, Truck>; day: string };

const PANNI = ['Nariyal Pani', 'Jai Ho', 'AB', 'Organic'];
const KATTA = ['Green', 'Jaipur', 'White'];
const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** "Ashu" ~ "Ashu Parchan"; enough to trust a ref the model also named. */
const agrees = (a: string, b: string) => { const x = norm(a), y = norm(b); return !!x && !!y && (x.startsWith(y) || y.startsWith(x) || x.includes(y) || y.includes(x)); };
const paise = (r: unknown) => (typeof r === 'number' && r > 0 ? Math.round(r * 100) : 0);

/**
 * Bolo on the website. The terminal sends its own books with the recording; the portal has none,
 * so the shop's books are read here — once when the mic opens (warm), reused for the turn — and
 * the reply comes back resolved: a draft with real ids for the entry form, or the figures for the
 * answer, all in the one round trip.
 */
@Injectable()
export class PortalVoiceService {
  private readonly cache = new Map<string, Books>();
  private readonly principals = new Map<string, Principal>();

  constructor(
    private readonly db: Db, private readonly voice: VoiceService, private readonly accounts: AccountsService,
    private readonly admin: AdminService, private readonly reports: ReportsService, private readonly entries: EntriesService,
  ) {}

  /** Called when the mic opens: the books are ready by the time the person stops talking. */
  async warm(phone: string, shopId: string) {
    await Promise.all([this.books(shopId, true), this.principal(phone, shopId)]);
    return { ok: true };
  }

  async turn(phone: string, shopId: string, body: z.infer<typeof PortalTurnBody>) {
    const [books, p] = await Promise.all([this.books(shopId), this.principal(phone, shopId)]);
    const input = TurnBody.parse({ ...body, context: books.text });
    const { id, reply, ms } = await this.voice.turn(p, input);
    const out: Record<string, unknown> = { id, reply, ms };
    if (reply.kind === 'slip' || reply.kind === 'collect' || reply.kind === 'expense') out.draft = this.draft(reply, books);
    if (reply.kind === 'show') out.cards = await this.cards(shopId, reply, books);
    if (reply.kind === 'open') out.open = { to: reply.open, buyerId: this.buyer(reply, books)?.id ?? null, truckId: this.truck(reply, books)?.id ?? null };
    return out;
  }

  // ---------------------------------------------------------------- the books as the model reads them

  private async principal(phone: string, shopId: string) {
    const key = `${phone}:${shopId}`;
    let p = this.principals.get(key);
    if (!p) { p = await this.accounts.webDevice(phone, shopId); this.principals.set(key, p); }
    return p;
  }

  /** Fresh for 60 s: long enough for a warm and its turn, short enough that a new slip shows up. */
  private async books(shopId: string, refresh = false): Promise<Books> {
    const hit = this.cache.get(shopId);
    if (hit && !refresh && Date.now() - hit.at < 60_000) return hit;
    const [opts, rows, days] = await Promise.all([
      this.entries.options(shopId),
      this.db.withShop(shopId, (tx) => tx.query<{ id: string; name: string; code: string; bal: string | null }>(
        `SELECT g.id, g.name, g.code, x.bal FROM buyers g LEFT JOIN (${BALANCES}) x ON x.buyer_id = g.id
         WHERE NOT g.hidden AND lower(trim(g.name)) NOT IN ('cash', 'bank', 'free') ORDER BY g.name LIMIT 2000`)),
      this.db.withShop(shopId, (tx) => tx.query<{ d: string | null }>(
        `SELECT GREATEST((SELECT MAX(business_date) FROM bills), (SELECT MAX(business_date) FROM collections))::text AS d`)),
    ]);
    const today = todayIst();
    const last = days.rows[0]?.d?.slice(0, 10) ?? null;
    const day = last && last < today ? last : today;
    const buyers = new Map<string, Buyer>();
    const trucks = new Map<string, Truck>();
    const lines: string[] = [];
    const weekday = new Date(`${today}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    lines.push(`Date: ${today} (${weekday}).${day !== today ? ` Working day: ${day} (no slips yet today, so "aaj" means ${day} and "kal" the day before it).` : ''} Commodity: ${opts.commodity === 'amrud' ? 'amrud (guava), sold per box' : 'nariyal (tender coconut), sold per dana'}.`);
    opts.trucks.slice(0, 40).forEach((t, i) => {
      const ref = `g${i + 1}`;
      trucks.set(ref, { id: t.id, number: t.number, supplier: t.supplier, left: t.left, brand: t.brand });
      lines.push(`GAADI ${ref} | ${t.number} | ${t.brand || '-'} | supplier ${t.supplier || '-'} | left ${t.left}`);
    });
    rows.rows.forEach((b, i) => {
      const ref = `b${i + 1}`;
      const bal = n(b.bal);
      buyers.set(ref, { id: b.id, name: b.name.trim(), code: b.code, balancePaise: bal });
      lines.push(`GRAHAK ${ref} | ${b.name.trim()}${b.code ? ` | code ${b.code}` : ''} | ${bal >= 0 ? `udhaar ${Math.round(bal / 100)}` : `jama ${Math.round(-bal / 100)}`}`);
    });
    lines.push(`PANNI: ${PANNI.join(', ')}`, `KATTA: ${KATTA.join(', ')} (10, 15 or 20 dana)`);
    const books = { text: lines.join('\n'), at: Date.now(), buyers, trucks, day };
    this.cache.set(shopId, books);
    return books;
  }

  private buyer(r: Reply, books: Books): Buyer | null {
    const ref = String(r.buyer ?? '').trim().toLowerCase();
    const name = String(r.buyer_name ?? '').trim();
    const byRef = books.buyers.get(ref);
    if (byRef && (!name || agrees(byRef.name, name))) return byRef;
    if (!name || ref === 'new') return null;
    return [...books.buyers.values()].find((b) => norm(b.name) === norm(name))
      ?? [...books.buyers.values()].find((b) => agrees(b.name, name)) ?? null;
  }

  private truck(r: Reply, books: Books): Truck | null {
    const ref = String(r.gaadi ?? '').trim().toLowerCase();
    const no = String(r.gaadi_no ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const byRef = books.trucks.get(ref);
    if (byRef && (no.length < 3 || byRef.number.toUpperCase().replace(/[^A-Z0-9]/g, '').endsWith(no.slice(-4)))) return byRef;
    if (no.length < 3) return byRef ?? null;
    return [...books.trucks.values()].find((t) => t.number.toUpperCase().replace(/[^A-Z0-9]/g, '').endsWith(no.slice(-4))) ?? null;
  }

  // ---------------------------------------------------------------- a draft for the entry form

  private draft(r: Reply, books: Books) {
    const b = this.buyer(r, books);
    const spoken = String(r.buyer_name ?? '').trim();
    const buyer = b ? { id: b.id, name: b.name, balancePaise: b.balancePaise } : spoken ? { id: null, name: spoken } : null;
    const pay = (r.pay ?? {}) as { mode?: string; cash?: number; upi?: number };
    const notes: string[] = [];
    if (!b && spoken && r.buyer !== 'new') notes.push(`"${spoken}" list mein nahi mila`);
    if (r.kind === 'collect') return { kind: 'vasooli', buyer, cashPaise: paise(pay.cash), upiPaise: paise(pay.upi), notes };
    if (r.kind === 'expense') {
      const e = (r.expense ?? {}) as { direction?: string; amount?: number; what?: string };
      return { kind: 'kharcha', dir: e.direction === 'in' ? 'in' : 'out', amountPaise: paise(e.amount), note: e.what ?? '', notes };
    }
    const s = (r.slip ?? {}) as {
      lines?: { grade?: string; qty?: number; rate?: number; amount?: number }[]; leak?: { qty?: number; amount?: number }
      packing?: string; panni?: string; katta_name?: string; kattas?: number; parchune?: boolean; delivery?: boolean; labour?: boolean
    };
    const lines = (s.lines ?? []).filter((l) => (l.qty ?? 0) > 0).map((l) => ({
      grade: l.grade === 'II' ? '2' : l.grade === 'III' ? '3' : '1',
      qty: Math.round(l.qty!),
      ratePaise: paise(l.rate) || (l.amount ? Math.round(paise(l.amount) / l.qty!) : 0),
    }));
    if (s.leak?.qty) {
      lines.push({ grade: 'mix', qty: Math.round(s.leak.qty), ratePaise: s.leak.amount ? Math.round(paise(s.leak.amount) / s.leak.qty) : 0 });
      notes.push('Leak ko Mix line mein likha hai');
    }
    const truck = this.truck(r, books);
    if (r.gaadi && !truck) notes.push(`Gaadi "${r.gaadi_no ?? ''}" nahi mili`);
    const mode = pay.mode;
    return {
      kind: 'parchi', buyer, truckId: truck?.id ?? null, lines,
      // Nothing said: a named grahak (listed or new) is udhaar, a walk-in pays cash — as on the terminal.
      pay: mode === 'udhaar' ? 'credit' : mode === 'mixed' ? 'split' : mode ?? (buyer ? 'credit' : null),
      cashPaise: paise(pay.cash), upiPaise: paise(pay.upi),
      packing: s.packing?.startsWith('katta') ? 'katta' : s.packing === 'panni' ? 'panni' : s.packing ? 'loose' : null,
      size: s.packing?.startsWith('katta') ? s.packing : null,
      kattaName: KATTA.find((k) => agrees(k, s.katta_name ?? '')) ?? '', kattas: s.kattas ?? null,
      panni: PANNI.find((k) => agrees(k, s.panni ?? '')) ?? '', parchune: !!s.parchune, delivery: !!s.delivery, labour: !!s.labour,
      notes,
    };
  }

  // ---------------------------------------------------------------- the answer, from the books

  private async cards(shopId: string, r: Reply, books: Books) {
    const views = ((r.views ?? []) as { view: string; buyer?: string; gaadi?: string; from?: string; to?: string }[]).slice(0, 3);
    const date = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
    const out = await Promise.all(views.map(async (v) => {
      const from = date(v.from) ?? books.day;
      const to = date(v.to) && date(v.to)! >= from ? date(v.to)! : from;
      const vb = this.buyer({ ...r, buyer: v.buyer ?? r.buyer, buyer_name: v.buyer ? '' : r.buyer_name } as Reply, books);
      switch (v.view) {
        case 'udhaar': {
          if (!vb) return null;
          const d = await this.admin.buyer(shopId, vb.id);
          return {
            view: 'udhaar', buyerId: vb.id, name: vb.name, balancePaise: d.totals.balancePaise, lastSlipOn: d.totals.lastSlipOn,
            recent: d.history.slice(-3).reverse().map((h) => ({ date: h.date, title: h.title, debitPaise: h.debitPaise, creditPaise: h.creditPaise })),
          };
        }
        case 'udhaar_list': {
          const o = await this.reports.outstanding(shopId, todayIst());
          return { view: 'udhaar_list', totalPaise: o.totals.duePaise, count: o.totals.count, rows: o.rows.slice(0, 6).map((x) => ({ buyerId: x.buyerId, name: x.name, duePaise: x.duePaise })) };
        }
        case 'bikri': case 'vasooli': case 'mazdoori': {
          const s = await this.admin.summary(shopId, from, to);
          return { view: v.view, from, to, salesPaise: s.salesPaise, slips: s.slips, nags: s.nags, cashPaise: s.cashPaise, upiPaise: s.upiPaise,
            creditPaise: s.creditLeftPaise, collectedCashPaise: s.collectedCashPaise, collectedUpiPaise: s.collectedUpiPaise, collections: s.collections, labourPaise: s.labourPaise };
        }
        case 'galla': {
          const c = await this.reports.cashbook(shopId, 'galla', from, to);
          return { view: 'galla', from, to, openingPaise: c.openingPaise, inPaise: c.inPaise, outPaise: c.outPaise, closingPaise: c.closingPaise };
        }
        case 'stock': case 'gaadi': {
          const st = await this.reports.stock(shopId, todayIst(), 'active');
          const t = v.gaadi ? books.trucks.get(v.gaadi.toLowerCase()) : null;
          const rows = st.rows.filter((x) => !t || x.truckId === t.id).slice(0, 8);
          return { view: 'stock', totalLeft: rows.reduce((a, x) => a + x.left, 0), rows: rows.map((x) => ({ truckId: x.truckId, number: x.number, supplier: x.supplier, left: x.left })) };
        }
        case 'supplier': {
          const s = await this.reports.suppliers(shopId, todayIst());
          return { view: 'supplier', totalPaise: s.totals.duePaise, rows: s.rows.filter((x) => x.duePaise > 0).slice(0, 6).map((x) => ({ key: x.key, name: x.name, duePaise: x.duePaise })) };
        }
        case 'parchi': {
          const d = await this.admin.daybook(shopId, from, to);
          const slips = d.entries.filter((e) => e.kind === 'slip' && !e.voided && (!vb || e.buyerId === vb.id));
          return { view: 'parchi', from, to, count: slips.length, rows: slips.slice(0, 8).map((e) => ({ id: e.id, title: e.title, party: e.party, nags: e.nags, amountPaise: e.amountPaise })) };
        }
        default: return null;
      }
    }));
    return out.filter(Boolean);
  }
}
