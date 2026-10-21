import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AccountsService } from '../auth/accounts.service';
import { Principal } from '../auth/tokens.service';
import { AdminService } from '../admin/admin.service';
import { EntriesService, type Grade, type ParchiInput } from '../admin/entries.service';
import { ReportsService } from '../admin/reports.service';
import { BALANCES, n } from '../admin/sql';
import { Db } from '../db/db.service';
import { uuidv7 } from '../common/uuid';
import { Reply, TurnBody, VoiceService } from './voice.service';
import { ASK_TABLES, ask } from './ask';
import { GeminiClient } from './gemini.client';
import { LIVE_BILLS } from '../admin/sql';
import { UdhaarAlertsService } from '../alerts/udhaar-alerts.service';
import { RemindersService, dueFrom, whenLabel } from '../alerts/reminders.service';
import { fold, key, near, resolve, score, type Person, type Resolution } from './resolve';
import { Sessions, mentions, numberIn, phoneIn, yesNo, type Expect, type Option, type Pending, type Session } from './session';

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
  // One conversation: Bolo remembers it (who it is about, a job waiting on an answer).
  session: z.string().max(64).optional(),
  // A tapped option for the question Bolo asked (no model needed).
  pick: z.string().max(120).optional(),
});

type Buyer = { id: string; name: string; code: string; phone: string; balancePaise: number };
type Truck = { id: string; number: string; supplier: string; left: number; brand: string; brandId: string | null };
type Books = {
  text: string; at: number; buyers: Map<string, Buyer>; trucks: Map<string, Truck>; day: string; brands: { id: string; name: string }[]
  /** Today's bhav by "brandId:grade", in paise. */
  rates: Map<string, number>; suppliers: string[]
};

const PANNI = ['Nariyal Pani', 'Jai Ho', 'AB', 'Organic'];
const KATTA = ['Green', 'Jaipur', 'White'];
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** "Ashu" ~ "Ashu Parchan"; enough to trust a ref the model also named. */
const agrees = (a: string, b: string) => { const x = norm(a), y = norm(b); return !!x && !!y && (x.startsWith(y) || y.startsWith(x) || x.includes(y) || y.includes(x)); };
const paise = (r: unknown) => (typeof r === 'number' && r > 0 ? Math.round(r * 100) : 0);
const CANCEL: Option = { label: 'Rehne dein', value: 'cancel' };
/** Words that make an utterance a request of its own, not an answer to the question waiting. */
const COMMAND = /\b(bhej|bhejo|bhejde|send|whatsapp|call|phone karo|parchi|bill|kaat|kaato|yaad|remind|reminder|gaadi add|nayi gaadi|udhaar|hisab|dikha|dikhao|khol|kholo|download|kitna|kitne|kitni|banao|bana do|jod|jodo|bhav|grahak)\b/i;
const gradeOf = (g?: string): Grade => (g === 'II' ? '2' : g === 'III' ? '3' : '1');
const roman = (g: string) => (g === '2' ? 'II' : g === '3' ? 'III' : g === 'mix' ? 'Leak' : 'I');
const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const titleCase = (n: string) => n.trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
/** A gaadi number as the books keep it: "mh 12 ab 3289" → "MH12AB3289". */
const plate = (n: unknown) => String(n ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const PACKINGS = ['loose', 'katta10', 'katta15', 'katta20', 'katta25', 'panni'] as const;

/** One cell as it is said: "505 dana", "₹1,25,000", "₹44.5" for a rate, a count plain. */
function cellText(k: string, v: unknown): string {
  if (typeof v !== 'number') return String(v ?? '');
  if (/dana|nag|qty|bacha$|bika$|aaya$|kharab$/i.test(k)) return `${Math.round(v).toLocaleString('en-IN')} dana`;
  if (/parchiyan|parchi/i.test(k)) return `${Math.round(v).toLocaleString('en-IN')} parchi`;
  if (/count|ginti|kitne|baar/i.test(k)) return Math.round(v).toLocaleString('en-IN');
  if (/bhav|rate/i.test(k)) return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  if (/rakam|udhaar|kharid|bikri|baaki|amount|rupay|total|kul|jama|cash|upi|munafa|kharcha|mila/i.test(k)) return `₹${Math.round(v).toLocaleString('en-IN')}`;
  return v.toLocaleString('en-IN');
}

/**
 * A query's answer in one line, from the rows: one row reads out its figures; several read the
 * first three by their name (or date) and figure, and how many there are. The table shows the rest.
 */
function sayRows(title: string, cols: string[], rows: Record<string, unknown>[]): string {
  if (!rows.length) return `${title}: kuch nahi mila`;
  const line = (r: Record<string, unknown>) => cols.map((k) => cellText(k, r[k])).filter((x) => x && x !== 'null').join(', ');
  if (rows.length === 1) return `${title}: ${line(rows[0])}`;
  const top = rows.slice(0, 3).map(line).join('; ');
  return `${title}: ${top}${rows.length > 3 ? ` — kul ${rows.length}` : ''}`;
}

type SlipSaid = {
  lines?: { grade?: string; qty?: number; rate?: number; amount?: number }[]; leak?: { qty?: number; amount?: number }
  packing?: string; panni?: string; katta_name?: string; kattas?: number; parchune?: boolean; delivery?: boolean; labour?: boolean
};
type SlipJob = { reply: Reply; heard: string; buyerId?: string; newGrahak?: boolean; walkIn?: boolean; truckId?: string; chooseTruck?: boolean; gaadiMiss?: string; qty?: number; rates?: Record<string, number>; cash?: number };
type GaadiSaid = { number?: string; supplier?: string; maal?: string; lines?: { grade?: string; qty?: number; rate?: number }[]; freight?: number };
type GaadiJob = {
  reply: Reply; init?: boolean; number?: string; supplier?: string; maal?: string; brandId?: string; newMaal?: string
  lines?: { grade: Grade; qty: number; ratePaise: number }[]; freightPaise?: number
};
type YaadSaid = { what?: string; day?: number; date?: string; time?: string; after_minutes?: number; part?: string; send_udhaar?: boolean; list?: boolean; cancel?: boolean };
type YaadJob = { reply: Reply; heard: string; at?: string; buyerId?: string; skipBuyer?: boolean };

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
  private readonly sessions = new Sessions();

  constructor(
    private readonly db: Db, private readonly voice: VoiceService, private readonly accounts: AccountsService,
    private readonly admin: AdminService, private readonly reports: ReportsService, private readonly entries: EntriesService,
    private readonly gemini: GeminiClient, private readonly alerts: UdhaarAlertsService, private readonly reminders: RemindersService,
  ) {}

  /** Called when the mic opens: the books are ready by the time the person stops talking. */
  async warm(phone: string, shopId: string) {
    await Promise.all([this.books(shopId, true), this.principal(phone, shopId)]);
    return { ok: true };
  }

  /**
   * One turn of the conversation. A job waiting on an answer ("number boliye", "kaun sa Om?")
   * takes the answer first — a tapped option or typed number needs no model at all, a spoken one
   * only a short transcription — and then finishes the job. Anything else is a fresh request:
   * the model routes it, and the routing is checked here (who exactly, is the number there)
   * before anything is done, so a gap becomes the next question, never an error.
   * [shops]: the other shops this person may open, for "Om AL Shamsh mein hai".
   */
  async turn(phone: string, shopId: string, body: z.infer<typeof PortalTurnBody>, shops: string[] = []) {
    const s = this.sessions.get(body.session, shopId);
    if (s.pending) {
      const asked = s.pending;
      const got = await this.reply(asked, body);
      // A preview acts only on its button: a heard "haan" shows it again instead of guessing.
      if (got.keep) return this.done(s, got.heard, { ask: { question: asked.question, expect: asked.expect, tap: true, options: asked.options, detail: asked.detail }, say: 'Neeche button dabaiye' });
      if (got.value !== undefined) {
        const out = await this.advance(phone, shopId, s, asked, got.value, shops);
        void this.logAnswer(phone, shopId, asked, got.heard || got.value, out);
        return this.done(s, got.heard, out);
      }
      // They said something else: the waiting job is dropped and this is a new request.
      s.pending = undefined;
      if (got.heard) body = { ...body, text: got.heard, audio: undefined, pick: undefined };
      else if (body.pick || (!body.audio && !body.text)) return this.done(s, '', { reply: { transcript: '', kind: 'answer', say: 'Theek hai' }, say: 'Theek hai' });
    }

    // A tap on a question that is gone (answered, timed out, or replaced): say so, do nothing.
    if (!body.audio && !body.text?.trim()) return this.done(s, '', { say: 'Ye sawaal purana ho gaya. Phir se boliye.' });
    const [books, p] = await Promise.all([this.books(shopId), this.principal(phone, shopId)]);
    const history = s.turns.length ? s.turns : body.history;
    const input = TurnBody.parse({ ...body, history, focus: this.focusText(s, books), context: books.text });
    const { id, reply, ms } = await this.voice.turn(p, input, true);
    const out: Record<string, unknown> = { id, reply, ms };
    Object.assign(out, await this.route(phone, shopId, s, reply, books, body.lang, p, shops));
    return this.done(s, reply.transcript, out);
  }

  /** What the reply needs done, after checking who and what exactly. */
  private async route(phone: string, shopId: string, s: Session, reply: Reply, books: Books, lang: z.infer<typeof PortalTurnBody>['lang'], p: Principal, shops: string[]) {
    const out: Record<string, unknown> = {};
    const heard = String(reply.heard ?? reply.buyer_name ?? '').trim();
    // "Gaadi aayi hai" routed to the blank form: start the questions instead, unless they asked for the screen.
    if (reply.kind === 'open' && reply.open === 'nayi_gaadi' && !/khol|screen|form|page|dikha/i.test(String(reply.transcript ?? ''))) reply.kind = 'gaadi';
    switch (reply.kind) {
      case 'whatsapp': case 'call': case 'grahak':
        return this.advance(phone, shopId, s, { job: reply.kind, expect: 'text', slot: 'buyer', question: '', data: { reply, heard }, tries: 0 }, undefined, shops);
      // Every slip — delivery too — settles grahak and gaadi, then opens the filled form.
      case 'slip': return this.advance(phone, shopId, s, { job: 'slip', expect: 'text', slot: 'buyer', question: '', data: { reply, heard }, tries: 0 }, undefined, shops);
      case 'gaadi': return this.advance(phone, shopId, s, { job: 'gaadi', expect: 'text', slot: 'number', question: '', data: { reply }, tries: 0 }, undefined, shops);
      case 'yaad': return this.advance(phone, shopId, s, { job: 'yaad', expect: 'text', slot: 'when', question: '', data: { reply, heard }, tries: 0 }, undefined, shops);
      case 'calc': return { answer: this.calc(reply) };
      case 'bhav': return this.advance(phone, shopId, s, { job: 'bhav', expect: 'choice', slot: 'confirm', question: '', data: { reply }, tries: 0 }, undefined, shops);
      default: break;
    }
    // Kinds that name a grahak: settle who, or ask, before the old handlers run.
    const needs = reply.kind === 'show' ? ((reply.views ?? []) as { view: string }[]).some((v) => v.view === 'udhaar')
      : (reply.kind === 'open' && reply.open === 'grahak_khata') || (reply.kind === 'download' && (reply.download as { report?: string })?.report === 'ledger')
        || ((reply.kind === 'edit') && !((reply.edit as { slip_no?: number })?.slip_no) && !!heard);
    if (needs && heard) {
      const pick = this.choose(heard, books, reply);
      if (!pick.id) {
        if (!pick.options.length) return this.notFound(s, shopId, heard, shops, { job: reply.kind as Pending['job'], data: { reply, heard } });
        s.pending = { job: reply.kind as Pending['job'], data: { reply, heard }, expect: 'choice', slot: 'buyer', question: `Kaun ${heard}?`, options: [...pick.options, CANCEL], tries: 0 };
        return { ask: { question: s.pending.question, expect: 'choice', options: s.pending.options } };
      }
      const who = [...books.buyers.values()].find((x) => x.id === pick.id)!;
      reply.buyer = this.refOf(books, who.id); reply.buyer_name = who.name;
      s.focus = { buyerId: who.id, buyerName: who.name };
    }
    if (reply.kind === 'slip' || reply.kind === 'collect' || reply.kind === 'expense') {
      if (heard && reply.kind !== 'expense' && String(reply.buyer ?? '') !== 'new') {
        const r = this.who(heard, books, reply);
        if (r.kind === 'some') return this.askBuyer(s, { job: 'draft', data: { reply, heard } }, r.options, heard, true);
        if (r.kind === 'one') { reply.buyer = this.refOf(books, r.who.id); reply.buyer_name = r.who.name; s.focus = { buyerId: r.who.id, buyerName: r.who.name }; }
      }
      out.draft = this.draft(reply, books);
    }
    if (reply.kind === 'show') out.cards = await this.cards(shopId, reply, books);
    if (reply.kind === 'open') out.open = { to: reply.open, buyerId: this.buyer(reply, books)?.id ?? null, truckId: this.truck(reply, books)?.id ?? null };
    if (reply.kind === 'query') out.answer = await this.answer(shopId, reply, lang, books);
    if (reply.kind === 'edit') Object.assign(out, await this.edit(p, shopId, reply, books, lang));
    if (reply.kind === 'download') {
      const d = (reply.download ?? {}) as { report?: string; format?: string; from?: string; to?: string };
      const b = this.buyer(reply, books);
      if (d.report === 'ledger' && !b) return this.notFound(s, shopId, heard, shops, { job: 'download', data: { reply, heard } });
      out.download = { report: d.report ?? 'daybook', format: d.format === 'excel' ? 'excel' : 'pdf', buyerId: b?.id ?? null, buyerName: b?.name ?? null, from: d.from ?? null, to: d.to ?? null };
    }
    return out;
  }

  // ---------------------------------------------------------------- the conversation: ask, then finish the job

  /** Remember the exchange and what it was about; tell the page whether a question is waiting. */
  private done(s: Session, heard: string, out: Record<string, unknown>) {
    const say = String((out.ask as { question?: string } | undefined)?.question ?? out.say ?? (out.answer as { say?: string } | undefined)?.say ?? (out.reply as Reply | undefined)?.say ?? '')
    this.sessions.note(s, heard, say);
    return { ...out, session: s.id || null };
  }

  /** "# Focus" for the model: who the conversation is about, by this shop's ref. */
  private focusText(s: Session, books: Books): string {
    if (!s.focus.buyerId) return '';
    const ref = this.refOf(books, s.focus.buyerId);
    return `They are talking about grahak ${s.focus.buyerName}${ref ? ` (${ref})` : ''}.`;
  }

  private refOf(books: Books, id: string): string {
    return [...books.buyers.entries()].find(([, b]) => b.id === id)?.[0] ?? '';
  }

  /** Scored against every grahak of the shop (not only those the model saw), the model's ref as a hint. */
  private who(heard: string, books: Books, reply?: Reply): Resolution {
    const hint = reply ? books.buyers.get(String(reply.buyer ?? '').toLowerCase())?.id : undefined;
    const people: Person[] = [...books.buyers.values()];
    // The model named a ref whose name is what they said: trust it when nothing else is as close.
    return resolve(heard, people, hint);
  }

  /** "Kaun sa Om?" — the close names as options, plus a way out. */
  private askBuyer(s: Session, job: Pick<Pending, 'job' | 'data'>, options: { id: string; name: string; balancePaise: number; phone: string }[], heard: string, allowNew = false) {
    const opts: Option[] = options.map((o) => ({ label: `${o.name}${o.balancePaise > 0 ? ` · ₹${Math.round(o.balancePaise / 100).toLocaleString('en-IN')}` : ''}`, value: o.id }));
    if (allowNew) opts.push({ label: `Naya grahak "${heard}"`, value: 'new' });
    const question = options.length === 1 ? `${options[0].name} ki baat kar rahe hain?` : `Kaun sa ${heard}? ${options.slice(0, 3).map((o) => o.name).join(', ')}?`;
    if (options.length === 1) opts.splice(0, 1, { label: `Haan, ${options[0].name}`, value: options[0].id });
    s.pending = { ...job, expect: 'choice', slot: 'buyer', question, options: opts, tries: 0 };
    return { ask: { question, expect: 'choice', options: opts } };
  }

  /** Nobody of that name here: other shops of theirs, or a new grahak, never a bare "nahi mila". */
  private async notFound(s: Session, shopId: string, heard: string, shops: string[], job: Pick<Pending, 'job' | 'data'>) {
    const elsewhere = await this.elsewhere(heard, shops.filter((x) => x !== shopId));
    const opts: Option[] = elsewhere.map((e) => ({ label: `${e.name} (${e.shopName})`, value: `go:${e.shopId}:${e.id}` }));
    if (job.job === 'whatsapp' || job.job === 'call' || job.job === 'grahak') opts.push({ label: `Naya grahak "${heard}" banayein`, value: 'new' });
    opts.push({ label: 'Rehne dein', value: 'cancel' });
    const question = elsewhere.length
      ? `${heard} is dukaan mein nahi, ${elsewhere.map((e) => e.shopName).join(', ')} mein hai. Wahan karein?`
      : `${heard} naam ka grahak nahi mila. Naya grahak banayein, ya naam phir se boliye.`;
    s.pending = { ...job, expect: 'choice', slot: 'buyer', question, options: opts, tries: 0 };
    return { ask: { question, expect: 'choice', options: opts } };
  }

  /** Grahaks of that name in the person's other shops. */
  private async elsewhere(heard: string, shops: string[]) {
    const found: { shopId: string; shopName: string; id: string; name: string; score: number }[] = [];
    for (const shopId of shops.slice(0, 8)) {
      const rows = await this.db.withShop(shopId, (tx) => tx.query<{ id: string; name: string; code: string; phone: string; shop: string }>(
        `SELECT g.id, g.name, g.code, g.phone, (SELECT name FROM shops WHERE id = $1) AS shop FROM buyers g WHERE NOT g.hidden`, [shopId]));
      for (const r of rows.rows) {
        const sc = score(heard, r);
        if (sc >= 0.85) found.push({ shopId, shopName: r.shop, id: r.id, name: r.name, score: sc });
      }
    }
    return found.sort((a, b) => b.score - a.score).slice(0, 3);
  }

  /**
   * The answer to a waiting question. A tap carries its value; typed text is read here (ten
   * digits, haan/nahi, an option's name); a recording gets one short transcription call with no
   * shop data, then the same reading. Anything that is not an answer comes back as heard text,
   * to be taken as a new request.
   */
  private async reply(q: Pending, body: z.infer<typeof PortalTurnBody>): Promise<{ value?: string; heard: string; keep?: boolean }> {
    if (body.pick) return q.options?.some((o) => o.value === body.pick) || q.expect !== 'choice' ? { value: body.pick, heard: q.options?.find((o) => o.value === body.pick)?.label ?? body.pick } : { heard: '' };
    let heard = body.text?.trim() ?? '';
    if (!heard && body.audio) heard = await this.transcribe(q, body).catch(() => '');
    if (!heard) return { heard: '' };
    const words = heard.split(/\s+/).filter(Boolean).length;
    const yn = yesNo(heard);
    const quit = /^(cancel|rehne do|rehne dein|chhodo|chhod do|mat karo|band karo|nahi|nahin)\b/i.test(heard.trim());
    // Anything that sounds like a new request is one — never squeezed into the question's slot.
    const command = words > 4 || COMMAND.test(heard);
    // On a preview, a no cancels; a yes ("haan jod do") or a word or two shows it again for the tap.
    if (q.slot === 'confirm') return quit && words <= 3 ? { value: 'cancel', heard } : yn === 'yes' || (words <= 3 && !command) ? { heard, keep: true } : { heard };
    if (quit && words <= 3) return { value: 'cancel', heard };
    if (q.expect === 'phone') { const ph = phoneIn(heard); return ph && words <= 6 ? { value: ph, heard } : { heard }; }
    if (q.expect === 'number') { const x = numberIn(heard); return x !== null && !command ? { value: String(x), heard } : { heard }; }
    if (command) return { heard };
    if (q.expect === 'text') {
      // The exact option first ("Pollachi Traders" is not "Pollachi"), then a close one, else the words as said.
      const exact = q.options?.find((o) => o.value !== 'cancel' && o.label.toLowerCase() === heard.toLowerCase());
      const named = exact ?? q.options?.find((o) => o.value !== 'cancel' && score(heard, { name: o.label.replace(/·.*$/, ''), code: '', phone: '' }) >= 0.85);
      return { value: named?.value ?? heard, heard };
    }
    if (q.expect === 'choice' && q.options?.length) {
      const opts = q.options.filter((o) => o.value !== 'cancel');
      const exact = opts.find((o) => fold(o.label.replace(/·.*$|\(.*\)|"/g, '')) === fold(heard));
      if (exact) return { value: exact.value, heard };
      const nth = words <= 2 ? ['pehla', 'pahla', 'first', 'doosra', 'dusra', 'second', 'teesra', 'tisra', 'third'].findIndex((w) => new RegExp(`\\b${w}\\b`, 'i').test(heard)) : -1;
      if (nth >= 0) { const o = opts[Math.floor(nth / 3)]; if (o) return { value: o.value, heard } }
      // One option, and only one, close to what they said.
      const close = opts.map((o) => ({ o, sc: score(heard, { name: o.label.replace(/·.*$|\(.*\)|"/g, ''), code: '', phone: '' }) })).filter((x) => x.sc >= 0.75);
      if (close.length === 1) return { value: close[0].o.value, heard };
    }
    return { heard };
  }

  /** Answers to Bolo's questions never reach the model; they are logged here so a conversation can be read back. */
  private async logAnswer(phone: string, shopId: string, q: Pending, heard: string, out: Record<string, unknown>) {
    try {
      const p = await this.principal(phone, shopId);
      const reply = { kind: `answer:${q.job}:${q.slot}`, transcript: heard, asked: q.question, ...Object.fromEntries(Object.entries(out).filter(([k]) => ['say', 'ask', 'draft', 'whatsapp', 'call', 'saved', 'go'].includes(k))) };
      await this.db.withShop(shopId, (tx) => tx.query(
        `INSERT INTO voice_turns (id, shop_id, user_id, device_id, screen, transcript, kind, reply, model) VALUES ($1, $2, $3, $4, 'portal', $5, $6, $7, 'none')`,
        [uuidv7(), shopId, p.userId, p.deviceId, heard.slice(0, 500), reply.kind.slice(0, 40), JSON.stringify(reply)]));
    } catch (e) {
      this.log(`answer not recorded: ${(e as Error).message}`);
    }
  }

  /** A short spoken answer, written down — no shop data, so it comes back in about a second. */
  private async transcribe(q: Pending, body: z.infer<typeof PortalTurnBody>): Promise<string> {
    const r = await this.gemini.generate({
      systemInstruction: { parts: [{ text: `Write down exactly what this person in an Indian mandi shop says, in Latin-script Hinglish. Numbers as digits; a phone number as its digits with no spaces ("nau zero do do…" = 902…). They are answering: "${q.question}"${q.options?.length ? ` (choices: ${q.options.map((o) => o.label).join(' / ')})` : ''}. Return {"transcript": "..."}.` }] },
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: body.mime, data: body.audio } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 120, responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object', properties: { transcript: { type: 'string' } }, required: ['transcript'] },
        thinkingConfig: { thinkingLevel: 'MINIMAL' } },
    }, undefined, 6_000);
    return String((JSON.parse(r.text) as { transcript?: string }).transcript ?? '').trim();
  }

  /**
   * One step of a job with what is known so far: who (asking if unsure), their number (asking if
   * missing, then saving it on the grahak), and then the thing itself. Called for the first turn
   * and again after every answer, so each gap is filled in turn and the job finishes by itself.
   */
  private async advance(phone: string, shopId: string, s: Session, q: Pending, value: string | undefined, shops: string[]): Promise<Record<string, unknown>> {
    const data = q.data as { reply: Reply; heard: string; buyerId?: string; shopId?: string; newGrahak?: boolean };
    const reply = data.reply;
    s.pending = undefined;
    if (value === 'cancel' || value === 'no') return { say: 'Theek hai, rehne diya', reply: { transcript: '', kind: 'answer', say: 'Theek hai, rehne diya' } };
    if (q.job === 'slip') return this.slipStep(phone, shopId, s, q, value);
    if (q.job === 'gaadi') return this.gaadiStep(phone, shopId, s, q, value);
    if (q.job === 'yaad') return this.yaadStep(phone, shopId, s, q, value);
    if (q.job === 'bhav') return this.bhavStep(phone, shopId, s, q, value);
    if (q.slot === 'buyer' && value) {
      if (q.expect === 'text') data.heard = value;
      else if (value.startsWith('go:')) { const [, sid, bid] = value.split(':'); data.shopId = sid; data.buyerId = bid; }
      else if (value === 'new') data.newGrahak = true;
      else data.buyerId = value;
    }
    const target = data.shopId ?? shopId;
    // A pick for a job the old handlers run (show, open, download, edit): run it for that grahak.
    if (q.job !== 'whatsapp' && q.job !== 'call' && q.job !== 'grahak') {
      if (data.shopId && data.shopId !== shopId && data.buyerId) return { go: { shopId: data.shopId, buyerId: data.buyerId }, say: 'Us dukaan mein khol rahe hain' };
      const books = await this.books(shopId);
      if (data.newGrahak) { reply.buyer = 'new'; reply.buyer_name = data.heard; }
      else if (data.buyerId) { reply.buyer = this.refOf(books, data.buyerId); const b = books.buyers.get(String(reply.buyer)); reply.buyer_name = b?.name ?? reply.buyer_name; if (b) s.focus = { buyerId: b.id, buyerName: b.name }; }
      reply.heard = '';
      const p = await this.principal(phone, shopId);
      return { reply, ...(await this.route(phone, shopId, s, reply, books, 'hinglish', p, shops)) };
    }

    // whatsapp / call / grahak: who — the exact grahak, or a question.
    const books = await this.books(target);
    const g = (reply.grahak ?? {}) as { name?: string; phone?: string; address?: string; code?: string; opening?: number; new?: boolean };
    if (!data.buyerId && !data.newGrahak) {
      if (q.job === 'grahak' && g.new) data.newGrahak = true;
      else if (!data.heard && s.focus.buyerId) data.buyerId = s.focus.buyerId;
      // No name and nobody in focus ("…ko ledger bhejde" with the name cut off): ask whose.
      else if (!data.heard) return this.ask(s, q, data, 'buyer', 'text', q.job === 'call' ? 'Kisko call karein? Naam boliye' : 'Kiska? Grahak ka naam boliye', [CANCEL]);
      else {
        const pick = this.choose(data.heard, books, reply);
        if (pick.id) data.buyerId = pick.id;
        else {
          const others = pick.options.length ? [] : await this.elsewhere(data.heard, shops.filter((x) => x !== shopId));
          return this.ask(s, q, data, 'buyer', 'choice', others.length ? `${data.heard} is dukaan mein nahi, ${others.map((e) => e.shopName).join(', ')} mein hai. Wahan kholein?` : pick.options.length ? `Kaun ${data.heard}?` : `${data.heard} naam ka grahak nahi mila.`,
            [...pick.options, ...others.map((e) => ({ label: `${e.name} (${e.shopName})`, value: `go:${e.shopId}:${e.id}` })), { label: `Naya grahak "${titleCase(data.heard)}"`, value: 'new' }, CANCEL]);
        }
      }
    }
    if (data.shopId && data.shopId !== shopId && data.buyerId) return { go: { shopId: data.shopId, buyerId: data.buyerId }, say: 'Us dukaan mein khol rahe hain' };

    // A new grahak, or changes to one: read back, saved on a tap.
    if (data.newGrahak && !data.buyerId) {
      const name = titleCase(g.name || data.heard || '');
      if (!name) return this.ask(s, q, data, 'buyer', 'text', 'Naye grahak ka naam boliye', [CANCEL]);
      const ph = phoneIn(g.phone ?? '') ?? '';
      const detail = [`Naya grahak: ${name}`, ...(ph ? [`Mobile: ${ph}`] : []), ...(g.address ? [`Pata: ${g.address}`] : []), ...(g.opening ? [`Purana udhaar: ${rs(Math.round(g.opening * 100))}`] : [])];
      if (q.slot !== 'confirm' || value !== 'yes') return this.confirm(s, q, data, `Naya grahak ${name} banayein?`, 'Grahak banao', detail);
      const made = await this.entries.grahak(phone, target, { name, phone: ph, address: g.address ?? '', code: g.code ?? '', openingPaise: g.opening ? Math.round(g.opening * 100) : undefined });
      this.cache.delete(target);
      s.focus = { buyerId: made.id, buyerName: name };
      if (q.job === 'grahak') return { say: `Naya grahak ${name} ban gaya${ph ? `, number ${ph}` : ''}`, saved: { buyerId: made.id } };
      data.buyerId = made.id; data.newGrahak = false;
      return this.advance(phone, shopId, s, { ...q, slot: 'buyer', question: '', data }, undefined, shops);
    }
    const fresh = await this.books(target, true);
    const b = [...fresh.buyers.values()].find((x) => x.id === data.buyerId);
    if (!b) return { say: 'Woh grahak nahi mila, naam phir se boliye' };
    s.focus = { buyerId: b.id, buyerName: b.name };

    if (q.job === 'grahak') {
      const ph = g.phone ? phoneIn(g.phone) : null;
      if (g.phone && !ph) return this.ask(s, q, data, 'phone', 'phone', `${b.name} ka 10 ank ka mobile number boliye`, [CANCEL]);
      const patch: { phone?: string; address?: string; code?: string } = { ...(ph ? { phone: ph } : {}), ...(g.address ? { address: g.address } : {}), ...(g.code ? { code: g.code } : {}) };
      if (q.slot === 'phone' && value && phoneIn(value)) patch.phone = phoneIn(value)!;
      if (!Object.keys(patch).length) return this.ask(s, q, data, 'phone', 'phone', `${b.name} ka mobile number boliye`, [CANCEL]);
      (data as Record<string, unknown>).patch = patch;
      const detail = [b.name, ...(patch.phone ? [`Mobile: ${b.phone || '—'} → ${patch.phone}`] : []), ...(patch.address ? [`Pata: ${patch.address}`] : []), ...(patch.code ? [`Code: ${patch.code}`] : [])];
      if (q.slot !== 'confirm' || value !== 'yes') return this.confirm(s, q, data, `${b.name} ki jaankari badlein?`, 'Save karo', detail);
      await this.entries.updateGrahak(phone, target, b.id, ((data as Record<string, unknown>).patch ?? patch) as typeof patch);
      this.cache.delete(target);
      return { say: `${b.name} ki jaankari save ho gayi`, saved: { buyerId: b.id } };
    }

    if (q.job === 'whatsapp' && !this.alerts.canSend()) return { say: 'WhatsApp abhi chalu nahi hai' };
    if (q.job === 'whatsapp' && b.balancePaise <= 0) return { say: `${b.name} ka koi udhaar baaki nahi hai` };

    // whatsapp / call need their number: asked, then saved on the grahak only on a tap.
    let mobile = /^[6-9]\d{9}$/.test(b.phone) ? b.phone : '';
    const given = (data as Record<string, unknown>).mobile as string | undefined;
    if (!mobile && q.slot === 'phone' && value && phoneIn(value)) (data as Record<string, unknown>).mobile = phoneIn(value)!;
    const newNumber = (data as Record<string, unknown>).mobile as string | undefined ?? given;
    if (!mobile && !newNumber) return this.ask(s, q, data, 'phone', 'phone', `${b.name} ka mobile number save nahi hai. Number boliye`, [CANCEL]);
    if (!mobile && newNumber) {
      if (q.slot !== 'confirm' || value !== 'yes') return this.confirm(s, q, data, `${b.name} ka number ${newNumber} save karein?`, q.job === 'call' ? 'Save karke call karo' : 'Save karke WhatsApp dikhao', [b.name, `Mobile: ${newNumber}`]);
      await this.entries.updateGrahak(phone, target, b.id, { phone: newNumber });
      this.cache.delete(target);
      mobile = newNumber;
    }
    if (q.job === 'call') {
      if (!newNumber && (q.slot !== 'confirm' || value !== 'yes')) return this.confirm(s, q, data, `${b.name} ko call karein?`, `Call karo · ${mobile}`, [b.name, `Mobile: ${mobile}`]);
      return { call: { phone: mobile, name: b.name }, say: `${b.name} ko call laga rahe hain` };
    }
    // whatsapp: the WhatsApp dialog is the preview — the message, the khata PDF, and its Send button.
    return { whatsapp: { buyerId: b.id, name: b.name }, say: `${b.name} ka WhatsApp dekh kar Bhejein dabaiye` };
  }

  /**
   * The grahak a name means, only when it cannot be anyone else: their exact name (spellings
   * folded), their code, or their number — or the one close name when nothing else is near.
   * Anything less returns the candidates (the model's pick first, then the closest) to ask.
   */
  private choose(heard: string, books: Books, reply?: Reply): { id?: string; options: Option[] } {
    const people = [...books.buyers.values()];
    const f = key(heard), digits = heard.replace(/\D/g, '');
    const exact = people.filter((p) => key(p.name) === f || (!!p.code && key(p.code).replace(/\s/g, '') === f.replace(/\s/g, ''))
      || (digits.length >= 10 && !!p.phone && p.phone.endsWith(digits.slice(-10))));
    if (exact.length === 1) return { id: exact[0].id, options: [] };
    const scored = people.map((p) => ({ p, sc: Math.max(score(heard, p), near(heard, p.name) * 0.8) })).filter((x) => x.sc >= 0.5).sort((a, b) => b.sc - a.sc);
    // One name that has every word they said, and no other name anywhere near it.
    if (!exact.length && scored.length && scored[0].sc >= 0.85 && (scored.length === 1 || scored[1].sc < 0.6)) return { id: scored[0].p.id, options: [] };
    const hint = books.buyers.get(String(reply?.buyer ?? '').toLowerCase());
    const seen = new Set<string>();
    const cands = [...exact, ...(hint ? [hint] : []), ...scored.map((x) => x.p)].filter((p) => !seen.has(p.id) && !!seen.add(p.id)).slice(0, 4);
    return { options: cands.map((p) => ({ label: `${p.name}${p.balancePaise > 0 ? ` · ₹${Math.round(p.balancePaise / 100).toLocaleString('en-IN')}` : ''}`, value: p.id })) };
  }

  /**
   * Ask the next thing a job needs; the job waits in the session for the answer. The same
   * question missed three times gives up politely instead of looping.
   */
  private ask(s: Session, q: Pending, data: object, slot: Pending['slot'], expect: Expect, question: string, options: Option[] = [], detail?: string[]) {
    const tries = q.slot === slot && q.question ? q.tries + 1 : 0;
    if (tries >= 3) { s.pending = undefined; return { say: 'Samajh nahi aaya. Ek baar poori baat phir se boliye.' }; }
    s.pending = { job: q.job, data: data as Record<string, unknown>, slot, expect, question, options, detail, tries };
    return { ask: { question, expect, options, ...(detail?.length ? { detail } : {}) } };
  }

  /** The preview of something Bolo is about to do: done only on a tap of [yes], never on a heard "haan". */
  private confirm(s: Session, q: Pending, data: object, question: string, yes: string, detail: string[], extra: Option[] = []) {
    s.pending = { job: q.job, data: data as Record<string, unknown>, slot: 'confirm', expect: 'choice', question, options: [{ label: yes, value: 'yes' }, ...extra, CANCEL], detail, tries: 0 };
    return { ask: { question, expect: 'choice', tap: true, options: s.pending.options, detail } };
  }

  // ---------------------------------------------------------------- a parchi, into the form

  /**
   * "Khurshid ji ko 1300 ek number 40 ke": who (asked unless it can only be one grahak), which
   * gaadi (asked by number unless they named it — the maal comes on any vehicle), and then the
   * parchi form opens filled in; the counter checks it there and taps Save, as always.
   */
  private async slipStep(phone: string, shopId: string, s: Session, q: Pending, value: string | undefined): Promise<Record<string, unknown>> {
    const d = q.data as unknown as SlipJob;
    const r = d.reply;
    const books = await this.books(shopId);
    // "35 panni 43 ke" is 35 dana packed in panni: a panni has a name, never a count.
    const sl = { ...((r.slip ?? {}) as SlipSaid) };
    if (sl.packing === 'panni' && sl.kattas) {
      if (!(sl.lines ?? []).some((l) => (l.qty ?? 0) > 0)) sl.lines = [{ ...(sl.lines?.[0] ?? { grade: 'I' }), qty: sl.kattas }, ...(sl.lines ?? []).slice(1)];
      delete sl.kattas;
    }
    r.slip = sl;
    if (value !== undefined) {
      if (q.slot === 'buyer') { if (value === 'new') d.newGrahak = true; else if (q.expect === 'text') d.heard = value; else d.buyerId = value; }
      if (q.slot === 'gaadi') {
        // A tap carries the id; a spoken or typed number ("3289", "AP39 wali") is matched on the plate.
        const said = plate(value).replace(/(WALI|WALA|GAADI|SE)+$/, '');
        const digits = said.replace(/\D/g, '');
        const hit = [...books.trucks.values()].filter((t) => t.id === value
          || (/\d/.test(said) && said.length >= 3 && (plate(t.number).includes(said) || (digits.length >= 3 && plate(t.number).replace(/\D/g, '').endsWith(digits)))));
        if (hit.length === 1) d.truckId = hit[0].id; else d.gaadiMiss = value;
      }
    }

    // Who: the exact grahak, or a question with the close names and "naya grahak".
    if (!d.buyerId && !d.newGrahak && !d.walkIn) {
      const name = (d.heard || String(r.buyer_name ?? '')).trim();
      if (!name || /^(cash|nakad|nagad)\b/i.test(name)) d.walkIn = true;
      else {
        const pick = this.choose(name, books, r);
        if (pick.id) d.buyerId = pick.id;
        else {
          d.heard = name;
          return this.ask(s, q, d, 'buyer', 'choice', pick.options.length ? `Kaun ${name}?` : `${name} naam ka grahak nahi mila.`,
            [...pick.options, { label: `Naya grahak "${titleCase(name)}"`, value: 'new' }, CANCEL]);
        }
      }
    }

    // Which gaadi: named, the only one open, or asked by number.
    const open = [...books.trucks.values()];
    if (!d.truckId) {
      const named = this.truck(r, books);
      const want = ((sl.lines ?? []).reduce((a, l) => a + (l.qty ?? 0), 0)) + (sl.leak?.qty ?? 0);
      const fits = open.filter((t) => t.left >= want);
      if (named && !d.gaadiMiss) d.truckId = named.id;
      else if (open.length === 1 && !r.gaadi_no && !d.gaadiMiss) d.truckId = open[0].id;
      else if (open.length) {
        const miss = d.gaadiMiss ?? (r.gaadi_no ? String(r.gaadi_no) : '');
        d.gaadiMiss = undefined;
        return this.ask(s, q, d, 'gaadi', 'text', `${miss ? `Gaadi ${miss} khuli nahi mili. ` : ''}Kaun si gaadi se? Gaadi number boliye`,
          [...(fits.length ? fits : open).slice(0, 6).map((t) => ({ label: `${t.number} · ${t.brand || 'maal'} · ${t.left.toLocaleString('en-IN')} bache`, value: t.id })), CANCEL]);
      }
    }

    // The form, filled in: everything said, the grahak and gaadi settled, a missing rate from today's bhav.
    const buyer = d.buyerId ? [...books.buyers.values()].find((x) => x.id === d.buyerId) ?? null : null;
    const newName = titleCase(d.heard || String(r.buyer_name ?? ''));
    const truckRef = [...books.trucks.entries()].find(([, t]) => t.id === d.truckId)?.[0] ?? null;
    const draft = this.draft({ ...r, buyer: buyer ? this.refOf(books, buyer.id) : d.newGrahak ? 'new' : null, buyer_name: buyer?.name ?? (d.newGrahak ? newName : ''), gaadi: truckRef, gaadi_no: null } as Reply, books) as Record<string, unknown> & { lines: { grade: Grade; qty: number; ratePaise: number }[]; notes: string[] };
    draft.truckId = d.truckId ?? null;
    const truck = open.find((t) => t.id === d.truckId);
    let fromBhav = false;
    for (const l of draft.lines) {
      if (l.ratePaise || !truck?.brandId) continue;
      const bhav = books.rates.get(`${truck.brandId}:${l.grade}`);
      if (bhav) { l.ratePaise = bhav; fromBhav = true; }
    }
    draft.notes = [...draft.notes.filter((n) => !/list mein nahi mila/.test(n)),
      ...(d.newGrahak ? [`Naya grahak "${newName}" banega`] : []), ...(fromBhav ? ['Rate aaj ke bhav se'] : [])];
    if (buyer) s.focus = { buyerId: buyer.id, buyerName: buyer.name };
    return { draft, say: `${buyer?.name ?? (d.newGrahak ? newName : 'Cash grahak')} ki parchi — dekh kar Save dabaiye` };
  }

  // ---------------------------------------------------------------- a gaadi, added by Bolo

  /**
   * "Ek gaadi add kar, Pollachi ki, 3289, 15000 dana ek number, 200 do number": number, dana and
   * maal are needed and asked for; the supplier is asked once with the usual ones as choices (or
   * left for later); then the gaadi is read back and added on a yes, as the Nayi gaadi form adds it.
   */
  private async gaadiStep(phone: string, shopId: string, s: Session, q: Pending, value: string | undefined): Promise<Record<string, unknown>> {
    const d = q.data as unknown as GaadiJob;
    const books = await this.books(shopId);
    if (!d.init) {
      const g = (d.reply.nayi_gaadi ?? {}) as GaadiSaid;
      d.init = true;
      d.number = plate(g.number) || undefined;
      d.supplier = g.supplier?.trim() || undefined;
      d.maal = g.maal?.trim() || undefined;
      d.lines = (g.lines ?? []).filter((l) => (l.qty ?? 0) > 0).map((l) => ({ grade: gradeOf(l.grade), qty: Math.round(l.qty!), ratePaise: paise(l.rate) }));
      d.freightPaise = paise(g.freight);
    }
    if (value !== undefined) {
      if (q.slot === 'number') { const n = plate(value); if (/\d{2,}/.test(n)) d.number = n; }
      if (q.slot === 'qty') { const x = numberIn(value); if (x) d.lines = [{ grade: '1', qty: Math.round(x), ratePaise: 0 }]; }
      if (q.slot === 'maal') { if (value.startsWith('id:')) d.brandId = value.slice(3); else d.maal = value; }
      if (q.slot === 'supplier') d.supplier = value === 'skip' ? '' : value;
    }
    if (!d.number) return this.ask(s, q, d, 'number', 'text', 'Gaadi ka number boliye (jaise 3289)', [CANCEL]);
    if (!d.lines?.length) return this.ask(s, q, d, 'qty', 'number', `Gaadi ${d.number} mein kitne dana aaye?`, [CANCEL]);
    if (!d.brandId && !d.newMaal) {
      const m = d.maal ? books.brands.map((b) => ({ b, sc: score(d.maal!, { name: b.name, code: '', phone: '' }) })).sort((a, b) => b.sc - a.sc)[0] : null;
      if (m && m.sc >= 0.6) d.brandId = m.b.id;
      else if (d.maal) d.newMaal = titleCase(d.maal);
      else if (books.brands.length === 1) d.brandId = books.brands[0].id;
      else return this.ask(s, q, d, 'maal', books.brands.length ? 'text' : 'text', 'Kaun sa maal hai?',
        [...books.brands.slice(0, 6).map((b) => ({ label: b.name, value: `id:${b.id}` })), CANCEL]);
    }
    if (d.supplier === undefined) {
      return this.ask(s, q, d, 'supplier', 'text', 'Supplier kaun hai?', [...books.suppliers.slice(0, 4).map((x) => ({ label: x, value: x })), { label: 'Baad mein', value: 'skip' }]);
    }
    const known = d.supplier ? books.suppliers.find((x) => x.toLowerCase() === d.supplier!.toLowerCase())
      ?? books.suppliers.find((x) => score(d.supplier!, { name: x, code: '', phone: '' }) >= 0.75) : undefined;
    const supplier = known ?? titleCase(d.supplier);
    const maal = d.brandId ? books.brands.find((b) => b.id === d.brandId)?.name ?? 'Maal' : d.newMaal!;
    const total = d.lines.reduce((a, l) => a + l.qty, 0);
    const dup = [...books.trucks.values()].find((t) => plate(t.number) === d.number);
    const detail = [
      `Gaadi ${d.number} · ${maal}${d.newMaal ? ' (naya maal)' : ''}`,
      ...d.lines.map((l) => `${roman(l.grade)}: ${l.qty.toLocaleString('en-IN')} dana${l.ratePaise ? ` × ${rs(l.ratePaise)}` : ''}`),
      `Supplier: ${supplier || 'baad mein'}${d.freightPaise ? ` · bhada ${rs(d.freightPaise)}` : ''}`,
    ];
    if (q.slot !== 'confirm' || value !== 'yes') {
      return this.confirm(s, q, d, `${dup ? `Gaadi ${d.number} pehle se khuli hai! ` : ''}Nayi gaadi ${d.number}, ${maal}, ${total.toLocaleString('en-IN')} dana. Jod dein?`, 'Gaadi jodo', detail);
    }
    try {
      const made = await this.entries.gaadi(phone, shopId, {
        number: d.number, supplier, freightPaise: d.freightPaise || undefined,
        lots: d.lines.map((l) => ({ ...(d.brandId ? { brandId: d.brandId } : { brandName: d.newMaal }), grade: l.grade, qty: l.qty, ratePaise: l.ratePaise })),
      });
      this.cache.delete(shopId);
      return { say: `Gaadi ${d.number} jud gayi: ${maal}, ${total.toLocaleString('en-IN')} dana`, saved: { truckId: made.truckId } };
    } catch (e) {
      return { say: (e as Error).message || 'Gaadi nahi judi, phir se boliye' };
    }
  }

  // ---------------------------------------------------------------- yaad dilana (reminders)

  /**
   * "Kal mujhe Afzal se 20000 lene ka yaad dilana": saved for the moment worked out from what was
   * said (a day with no time is 9 a.m.), read back from what was saved, and sent on WhatsApp to the
   * person who asked. "Afzal ko kal udhaar WhatsApp kar dena" sends the grahak their udhaar then.
   * Also lists what is pending and cancels one.
   */
  private async yaadStep(phone: string, shopId: string, s: Session, q: Pending, value: string | undefined): Promise<Record<string, unknown>> {
    const d = q.data as unknown as YaadJob;
    const y = (d.reply.yaad ?? {}) as YaadSaid;
    const what = (y.what || '').trim();

    if (y.list) {
      const all = await this.reminders.upcoming(shopId);
      return { answer: {
        title: 'Yaad (reminders)', columns: ['kab', 'kya'], rows: all.map((x) => ({ kab: x.label, kya: x.what })),
        say: all.length ? `${all.length} yaad baaki. Sabse pehle: ${all[0].label} — ${all[0].what}` : 'Koi yaad baaki nahi hai',
        speak: '',
      } };
    }
    if (y.cancel) {
      const all = await this.reminders.upcoming(shopId);
      const text = what || d.heard;
      let hit = value?.startsWith('rid:') ? all.filter((x) => x.id === value.slice(4)) : text
        ? all.filter((x) => fold(x.what).includes(fold(text)) || score(text, { name: x.what, code: '', phone: '' }) >= 0.6) : all;
      if (!hit.length && all.length === 1 && !text) hit = all;
      if (!hit.length) return { say: all.length ? 'Aisa koi yaad nahi mila' : 'Koi yaad baaki nahi hai' };
      if (hit.length > 1) return this.ask(s, q, d, 'pick', 'choice', 'Kaun sa yaad hatayein?', [...hit.slice(0, 5).map((x) => ({ label: `${x.label} · ${x.what}`, value: `rid:${x.id}` })), CANCEL]);
      await this.reminders.cancel(shopId, hit[0].id);
      return { say: `Hata diya: ${hit[0].label} — ${hit[0].what}`, saved: { reminder: hit[0].id } };
    }

    if (!what) return { say: 'Kis baat ka yaad dilayein? Poora boliye, jaise "kal subah Afzal se paise lene ka yaad dilana".' };
    if (q.slot === 'when' && value?.startsWith('at:')) d.at = value.slice(3);
    if (q.slot === 'buyer' && value) { if (value === 'skip') d.skipBuyer = true; else d.buyerId = value; }
    const now = new Date();
    const due = d.at ? { at: new Date(d.at), label: whenLabel(new Date(d.at), now) } : dueFrom(y, now);
    if ('ask' in due) {
      const opts: Option[] = [];
      const ist = new Date(now.getTime() + 330 * 60_000);
      const at = (dayOff: number, h: number) => new Date(Date.parse(`${new Date(ist.getTime() + dayOff * 86_400_000).toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}:00:00Z`) - 330 * 60_000);
      opts.push({ label: '1 ghante baad', value: `at:${new Date(now.getTime() + 3_600_000).toISOString()}` });
      if (ist.getUTCHours() < 17) opts.push({ label: 'Aaj shaam 6 baje', value: `at:${at(0, 18).toISOString()}` });
      opts.push({ label: 'Kal subah 9 baje', value: `at:${at(1, 9).toISOString()}` }, CANCEL);
      return this.ask(s, q, d, 'when', 'choice', due.ask === 'past' ? 'Woh samay nikal gaya. Kab yaad dilayein?' : due.ask === 'far' ? 'Itne aage ka yaad nahi rakh sakte. Kab dilayein?' : 'Kab yaad dilayein?', opts);
    }

    // A grahak it is about: their udhaar goes in the reminder (or to them, when asked).
    const books = await this.books(shopId);
    if (d.heard && !d.buyerId && !d.skipBuyer) {
      const pick = this.choose(d.heard, books, d.reply);
      if (pick.id) d.buyerId = pick.id;
      else if (pick.options.length) return this.ask(s, q, d, 'buyer', 'choice', `Kaun ${d.heard}?`, [...pick.options, { label: 'Koi grahak nahi', value: 'skip' }]);
    }
    const buyer = d.buyerId ? [...books.buyers.values()].find((b) => b.id === d.buyerId) : undefined;
    const toGrahak = !!y.send_udhaar && !!buyer && /^[6-9]\d{9}$/.test(buyer.phone);
    if (!/^[6-9]\d{9}$/.test(phone)) return { say: 'Aapka mobile number sahi nahi hai, yaad nahi rakh sakte' };
    if (q.slot !== 'confirm' || value !== 'yes') {
      d.at = due.at.toISOString();
      return this.confirm(s, q, d, `Yaad lagayein: ${due.label}?`, 'Yaad lagao', [
        `Kab: ${due.label}`, `Kya: ${what}`,
        toGrahak ? `${buyer!.name} ko udhaar WhatsApp jayega` : `WhatsApp ${phone} par aayega${buyer ? ` (${buyer.name} ka udhaar saath mein)` : ''}`,
        ...(y.send_udhaar && buyer && !toGrahak ? [`${buyer.name} ka number nahi hai, isliye sirf aapko`] : []),
        ...(this.alerts.canSend() ? [] : ['WhatsApp abhi band hai']),
      ]);
    }
    const saved = await this.reminders.create(shopId, phone, { toPhone: phone, what, at: due.at, buyerId: buyer?.id ?? null, action: toGrahak ? 'udhaar_whatsapp' : 'note' });
    const off = this.alerts.canSend() ? '' : ' (WhatsApp abhi band hai, website par dikhega)';
    const where = toGrahak ? `${buyer!.name} ko udhaar WhatsApp jayega` : `WhatsApp ${phone} par aayega`;
    const noPhone = y.send_udhaar && buyer && !toGrahak ? `. ${buyer.name} ka number nahi hai, isliye aapko yaad dilayenge` : '';
    return { say: `Yaad rakhenge: ${saved.label} — ${saved.what}. ${where}${noPhone}${off}`, saved: { reminder: saved.id, dueAt: saved.dueAt } };
  }

  // ---------------------------------------------------------------- arithmetic and the day's bhav

  /** "15 dana 22 ke aur 8 dana 35 ke" — added up here, never by the model. */
  private calc(r: Reply) {
    const c = (r.calc ?? {}) as { lines?: { qty?: number; rate?: number }[]; amounts?: number[] };
    const rows: Record<string, unknown>[] = [];
    let total = 0;
    for (const l of c.lines ?? []) {
      if (!l.qty || l.rate === undefined) continue;
      const amt = Math.round(l.qty * l.rate * 100) / 100;
      total += amt;
      rows.push({ hisab: `${l.qty} × ₹${l.rate}`, rakam: amt });
    }
    for (const a of c.amounts ?? []) { if (typeof a === 'number') { total += a; rows.push({ hisab: 'Rakam', rakam: a }); } }
    const t = `₹${Math.round(total).toLocaleString('en-IN')}`;
    return { title: 'Hisab', columns: ['hisab', 'rakam'], rows: [...rows, { hisab: 'Kul', rakam: Math.round(total * 100) / 100 }], say: rows.length ? `Kul ${t}` : 'Hisab samajh nahi aaya', speak: rows.length ? `कुल ${Math.round(total).toLocaleString('en-IN')} रुपये` : '' };
  }

  /** Today's bhav as said, each maal matched to the shop's own list: previewed, set on a tap. */
  private async bhavStep(phone: string, shopId: string, s: Session, q: Pending, value: string | undefined) {
    const r = (q.data as { reply: Reply }).reply;
    const books = await this.books(shopId);
    const rows = ((r.bhav ?? []) as { maal?: string; grade?: string; rate?: number }[]).filter((x) => x.rate && x.rate > 0);
    const set: { brandId: string; grade: '1' | '2' | '3'; ratePaise: number; label: string }[] = [];
    const missed: string[] = [];
    for (const x of rows) {
      const m = books.brands.map((b) => ({ b, sc: score(x.maal ?? '', { name: b.name, code: '', phone: '' }) })).sort((a, b) => b.sc - a.sc)[0];
      if (!m || m.sc < 0.6) { missed.push(x.maal ?? '?'); continue; }
      const grade = x.grade === 'II' ? '2' : x.grade === 'III' ? '3' : '1';
      set.push({ brandId: m.b.id, grade, ratePaise: Math.round(x.rate! * 100), label: `${m.b.name} ${x.grade ?? 'I'}: ₹${x.rate}` });
    }
    if (!set.length) return { say: missed.length ? `${missed.join(', ')} maal list mein nahi mila` : 'Bhav samajh nahi aaya, maal aur rate boliye' };
    if (value !== 'yes') return this.confirm(s, q, q.data, 'Aaj ka bhav lagayein?', 'Bhav lagao', [...set.map((x) => x.label), ...(missed.length ? [`${missed.join(', ')}: list mein nahi`] : [])]);
    await this.entries.setBhav(phone, shopId, { rates: set.map(({ label: _l, ...x }) => x) });
    this.cache.delete(shopId);
    return { say: `Aaj ka bhav laga diya: ${set.map((x) => x.label).join(', ')}`, saved: { bhav: set.length } };
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
      this.db.withShop(shopId, (tx) => tx.query<{ id: string; name: string; code: string; phone: string; bal: string | null; active: boolean }>(
        `SELECT g.id, g.name, g.code, g.phone, x.bal,
                (x.bal IS NOT NULL AND x.bal <> 0) OR g.created_at > now() - interval '30 days'
                  OR EXISTS (SELECT 1 FROM bills b WHERE b.buyer_id = g.id AND b.business_date > (now() - interval '120 days')::date)
                  OR EXISTS (SELECT 1 FROM collections c WHERE c.buyer_id = g.id AND c.business_date > (now() - interval '120 days')::date) AS active
         FROM buyers g LEFT JOIN (${BALANCES}) x ON x.buyer_id = g.id
         WHERE NOT g.hidden AND lower(trim(g.name)) NOT IN ('cash', 'bank', 'free') ORDER BY g.name LIMIT 5000`)),
      this.db.withShop(shopId, (tx) => tx.query<{ d: string | null }>(
        `SELECT GREATEST((SELECT MAX(business_date) FROM bills), (SELECT MAX(business_date) FROM collections))::text AS d`)),
    ]);
    const buyers = new Map<string, Buyer>();
    const trucks = new Map<string, Truck>();
    // What changes least goes first (the grahak names, the maal), what changes with every slip
    // (stock left, the date) last: the same opening reaches the model turn after turn, which
    // Vertex serves from its cache — and every line is as short as it can be, since every token
    // here is read on every turn and counts against the shared quota.
    const lines: string[] = ['GRAHAK (ref name [code]):'];
    // Every grahak is matched by the server; the model reads only the ones that are live —
    // owing, new, or bought or paid in the last 120 days. Balances are never sent: the books say them.
    let shown = 0;
    rows.rows.forEach((b, i) => {
      const ref = `b${i + 1}`;
      buyers.set(ref, { id: b.id, name: b.name.trim(), code: b.code, phone: b.phone ?? '', balancePaise: n(b.bal) });
      if (!b.active || shown >= 900) return;
      shown++;
      lines.push(`${ref} ${b.name.trim()}${b.code ? ` [${b.code}]` : ''}`);
    });
    if (opts.brands.length) lines.push(`MAAL: ${opts.brands.map((x) => x.name).join(', ')}`);
    lines.push(`PANNI: ${PANNI.join(', ')}`, `KATTA: ${KATTA.join(', ')} (10, 15 or 20 dana)`);
    opts.trucks.slice(0, 40).forEach((t, i) => {
      const ref = `g${i + 1}`;
      trucks.set(ref, { id: t.id, number: t.number, supplier: t.supplier, left: t.left, brand: t.brand, brandId: t.brandId });
      lines.push(`GAADI ${ref} | ${t.number} | ${t.brand || '-'} | supplier ${t.supplier || '-'} | left ${t.left}`);
    });
    const today = todayIst();
    const last = days.rows[0]?.d?.slice(0, 10) ?? null;
    const day = last && last < today ? last : today;
    const weekday = new Date(`${today}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    lines.push(`Date: ${today} (${weekday}).${day !== today ? ` Working day: ${day} (no slips yet today, so "aaj" means ${day} and "kal" the day before it).` : ''} Commodity: ${opts.commodity === 'amrud' ? 'amrud (guava), sold per box' : 'nariyal (tender coconut), sold per dana'}.`);
    const rates = new Map(opts.rates.map((x) => [`${x.brandId}:${x.grade}`, x.ratePaise] as const));
    const books = { text: lines.join('\n'), at: Date.now(), buyers, trucks, day, brands: opts.brands, rates, suppliers: opts.suppliers };
    this.cache.set(shopId, books);
    return books;
  }

  private buyer(r: Reply, books: Books): Buyer | null {
    const ref = String(r.buyer ?? '').trim().toLowerCase();
    const name = String(r.buyer_name ?? '').trim();
    const byRef = books.buyers.get(ref);
    if (byRef && (!name || agrees(byRef.name, name))) return byRef;
    if (!name) return null;
    // A name on the list is that grahak even when the model called it new; only a near match needs a real ref.
    const exact = [...books.buyers.values()].find((b) => norm(b.name) === norm(name));
    if (exact || ref === 'new') return exact ?? null;
    return [...books.buyers.values()].find((b) => agrees(b.name, name)) ?? null;
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
          // One grahak's slips with no period named: their last two months, not one day.
          const wide = vb && !date(v.from);
          const d = await this.admin.daybook(shopId, wide ? addDays(books.day, -60) : from, to);
          const slips = d.entries.filter((e) => e.kind === 'slip' && !e.voided && (!vb || e.buyerId === vb.id));
          return { view: 'parchi', from, to, count: slips.length, rows: slips.slice(0, 8).map((e) => ({ id: e.id, title: e.title, party: e.party, nags: e.nags, amountPaise: e.amountPaise })) };
        }
        default: return null;
      }
    }));
    return out.filter(Boolean);
  }

  // ---------------------------------------------------------------- a free question, read from the books

  /**
   * The model's SELECT over the voice tables (ask.ts), then a second, text-only call that says
   * the result in one line — numbers only from the rows. A bad query comes back as a plain miss.
   */
  private async answer(shopId: string, r: Reply, lang: string, books: Books) {
    const q = (r.query ?? {}) as { sql?: string; title?: string };
    const title = q.title || r.say;
    // The model names a grahak or gaadi by its ref from the shop data ('b170', 'g3'); the books
    // know which one that is, so the ref becomes its id here — never a guess on the name.
    const sql = (q.sql ?? '').replace(/'([bg])(\d{1,5})'/gi, (m, t: string, n: string) => {
      const ref = `${t.toLowerCase()}${n}`;
      const id = t.toLowerCase() === 'b' ? books.buyers.get(ref)?.id : books.trucks.get(ref)?.id;
      return id ? `'${id}'` : m;
    });
    let result;
    try {
      result = await ask(this.db, shopId, sql);
    } catch (e) {
      // One repair: the query and the database's own error go back to the model (a short call, no
      // shop data), and the corrected query runs once. Still wrong: say so, never a guess.
      this.log(`query refused or failed: ${(e as Error).message} :: ${sql}`);
      const fixed = await this.repair(r.transcript, sql, (e as Error).message).catch(() => null);
      result = fixed ? await ask(this.db, shopId, fixed).catch((e2: Error) => { this.log(`repair failed: ${e2.message} :: ${fixed}`); return null; }) : null;
      if (!result) return { title, columns: [], rows: [], say: lang === 'english' ? "Couldn't find that in the books" : 'Ye hisab nahi nikal paaye, alag tarah se poochiye', speak: 'ये हिसाब नहीं निकल पाए, अलग तरह से पूछिए' };
    }
    // The answer is said from the rows themselves — no second model call, so no number can drift.
    const shown = result.columns ?? Object.keys(result.rows[0] ?? {}).filter((k) => k !== 'id' && !k.endsWith('_id'));
    const say = sayRows(title, shown, result.rows);
    return { title, ...result, say, speak: say };
  }

  /** A failed query, corrected with the database's error. Returns the new SELECT. */
  private async repair(question: string, sql: string, error: string): Promise<string> {
    const r = await this.gemini.generate({
      systemInstruction: { parts: [{ text: `You fix one PostgreSQL SELECT that failed. Use ONLY these tables and columns:\n${ASK_TABLES}\nKeep what it asks; change only what the error points at. Return {"sql": "..."}.` }] },
      contents: [{ role: 'user', parts: [{ text: `Question: ${question}\nQuery: ${sql}\nError: ${error}` }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 400, responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] }, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
    }, undefined, 6_000);
    return String((JSON.parse(r.text) as { sql?: string }).sql ?? '');
  }

  private log(msg: string) { console.warn(`[PortalVoice] ${msg}`); }

  // ---------------------------------------------------------------- a change to a saved slip

  /**
   * Finds the slip (its number, the grahak's last, or the shop's last), lets the model correct it
   * the way a correction is made on the slip screen (the whole slip back, changed), and returns it
   * as the alter form takes it. Saving it there voids and rewrites, as Badlein does.
   */
  private async edit(p: Principal, shopId: string, r: Reply, books: Books, lang: z.infer<typeof PortalTurnBody>['lang']) {
    const e = (r.edit ?? {}) as { slip_no?: number; change?: string };
    const buyer = e.slip_no ? null : this.buyer(r, books);
    // A grahak was named but is not on the list: never fall back to some other slip.
    const named = String(r.buyer_name ?? '').trim();
    if (!e.slip_no && named && !buyer) return { editMiss: `${named} ki parchi nahi mili` };
    const found = (await this.db.withShop(shopId, (tx) => tx.query<{ id: string }>(
      `SELECT b.id FROM ${LIVE_BILLS} b WHERE ($1::int IS NULL OR b.slip_no = $1) AND ($2::uuid IS NULL OR b.buyer_id = $2)
       ORDER BY b.created_at DESC LIMIT 1`, [e.slip_no ?? null, buyer?.id ?? null]))).rows[0];
    if (!found) return { editMiss: e.slip_no ? `Parchi #${e.slip_no} nahi mili` : 'Parchi nahi mili' };
    const bill = await this.admin.bill(shopId, found.id);
    const second = await this.voice.turn(p, TurnBody.parse({
      text: e.change || r.transcript, draft: billText(bill, books), context: books.text, screen: 'parchi', lang,
    }), true);
    if (second.reply.kind !== 'slip') return { editMiss: second.reply.say || 'Badlav samajh nahi aaya' };
    return { edit: this.patch(bill, second.reply, books) };
  }

  private patch(bill: Bill, r: Reply, books: Books) {
    const s = (r.slip ?? {}) as { lines?: { grade?: string; qty?: number; rate?: number; amount?: number }[]; packing?: string; panni?: string; katta_name?: string; parchune?: boolean };
    const pay = (r.pay ?? {}) as { mode?: string; cash?: number; upi?: number };
    const leak = bill.lines.filter((l) => l.leak);
    const spoken = (s.lines ?? []).filter((l) => (l.qty ?? 0) > 0).map((l) => ({
      grade: l.grade === 'II' ? '2' : l.grade === 'III' ? '3' : '1', qty: Math.round(l.qty!),
      ratePaise: paise(l.rate) || (l.amount ? Math.round(paise(l.amount) / l.qty!) : 0), leak: false,
    }));
    const lines = spoken.length ? [...spoken, ...leak] : bill.lines;
    const total = lines.reduce((t, l) => t + l.qty * l.ratePaise, 0);
    const b = this.buyer(r, books);
    const named = String(r.buyer_name ?? '').trim();
    const buyer = b ? { buyerId: b.id, buyerName: b.name } : named && r.buyer === 'new' ? { buyerId: null, buyerName: named } : { buyerId: bill.buyerId, buyerName: bill.buyerName };
    // The payment as it was picked, unless they changed it; amounts follow the new total.
    const was = bill.payMode === 'free' || bill.payMode === 'after' ? bill.payMode
      : bill.paidPaise === 0 ? 'udhaar' : bill.cashPaise === bill.totalPaise ? 'cash' : bill.upiPaise === bill.totalPaise ? 'upi' : 'mixed';
    const mode = pay.mode ?? was;
    const money = mode === 'cash' ? { payMode: 'cash', cashPaise: total, upiPaise: 0 }
      : mode === 'upi' ? { payMode: 'upi', cashPaise: 0, upiPaise: total }
      : mode === 'free' || mode === 'after' ? { payMode: mode, cashPaise: 0, upiPaise: 0 }
      : mode === 'mixed' ? (() => {
          const cash = pay.cash !== undefined ? paise(pay.cash) : bill.cashPaise, upi = pay.upi !== undefined ? paise(pay.upi) : Math.max(0, total - cash);
          return { payMode: 'mixed', cashPaise: Math.min(cash, total), upiPaise: Math.min(upi, Math.max(0, total - cash)) };
        })()
      : { payMode: 'credit', cashPaise: 0, upiPaise: 0 };
    let packing = bill.packing, panniName = bill.panniName;
    if (s.packing) {
      packing = s.packing;
      panniName = s.packing === 'panni' ? (PANNI.find((k) => agrees(k, s.panni ?? '')) ?? '') : s.packing.startsWith('katta') ? (KATTA.find((k) => agrees(k, s.katta_name ?? '')) ?? '') : '';
      if (s.parchune && !s.packing.startsWith('katta')) panniName = panniName ? `${panniName} + Parchune` : 'Parchune';
    }
    const t = this.truck(r, books);
    return {
      ...bill, ...buyer, ...money, lines, totalPaise: total, paidPaise: money.cashPaise + money.upiPaise, packing, panniName,
      ...(t ? { truckId: t.id, truck: t.number } : {}),
    };
  }
}

type Bill = Awaited<ReturnType<AdminService['bill']>>;

/** A saved slip in the words the slip screen sends the model for a correction. */
function billText(b: Bill, books: Books): string {
  const ref = [...books.buyers.entries()].find(([, x]) => x.id === b.buyerId)?.[0];
  const roman = (g: string) => (g === '2' ? 'II' : g === '3' ? 'III' : g === 'mix' ? 'mix' : 'I');
  const pay = b.payMode === 'free' ? 'free' : b.payMode === 'after' ? 'after payment' : b.paidPaise === 0 ? 'udhaar'
    : b.cashPaise === b.totalPaise ? 'cash' : b.upiPaise === b.totalPaise ? 'upi' : `mixed cash ${b.cashPaise / 100} upi ${b.upiPaise / 100}`;
  return [
    `Parchi #${b.slipNo ?? ''}`,
    `Grahak: ${b.buyerName}${ref ? ` (${ref})` : ''}`,
    b.truck ? `Gaadi: ${b.truck}` : '',
    ...b.lines.filter((l) => !l.leak).map((l) => `Line: ${roman(l.grade)} ${l.qty} dana @ ${l.ratePaise / 100}`),
    ...b.lines.filter((l) => l.leak).map((l) => `Leak: ${l.qty} dana for total ${(l.qty * l.ratePaise) / 100}`),
    `Packing: ${b.packing}${b.panniName ? ` ${b.panniName}` : ''}`,
    b.delivery ? 'Delivery: yes' : '',
    b.labourPaise > 0 ? 'Mazdoori: yes' : '',
    `Pay: ${pay}`,
  ].filter(Boolean).join('\n');
}

