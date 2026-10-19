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
import { ask } from './ask';
import { GeminiClient } from './gemini.client';
import { LIVE_BILLS } from '../admin/sql';
import { UdhaarAlertsService } from '../alerts/udhaar-alerts.service';
import { fold, resolve, score, type Person, type Resolution } from './resolve';
import { Sessions, phoneIn, yesNo, type Option, type Pending, type Session } from './session';

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
type Truck = { id: string; number: string; supplier: string; left: number; brand: string };
type Books = { text: string; at: number; buyers: Map<string, Buyer>; trucks: Map<string, Truck>; day: string; brands: { id: string; name: string }[] };

const PANNI = ['Nariyal Pani', 'Jai Ho', 'AB', 'Organic'];
const KATTA = ['Green', 'Jaipur', 'White'];
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
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
  private readonly sessions = new Sessions();

  constructor(
    private readonly db: Db, private readonly voice: VoiceService, private readonly accounts: AccountsService,
    private readonly admin: AdminService, private readonly reports: ReportsService, private readonly entries: EntriesService,
    private readonly gemini: GeminiClient, private readonly alerts: UdhaarAlertsService,
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
      const got = await this.reply(s.pending, body);
      if (got.value !== undefined) return this.done(s, got.heard, await this.advance(phone, shopId, s, s.pending, got.value, shops));
      // They said something else: the waiting job is dropped and this is a new request.
      s.pending = undefined;
      if (got.heard) body = { ...body, text: got.heard, audio: undefined, pick: undefined };
      else if (body.pick || (!body.audio && !body.text)) return this.done(s, '', { reply: { transcript: '', kind: 'answer', say: 'Theek hai' }, say: 'Theek hai' });
    }

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
    switch (reply.kind) {
      case 'whatsapp': case 'call': case 'grahak':
        return this.advance(phone, shopId, s, { job: reply.kind, expect: 'text', slot: 'buyer', question: '', data: { reply, heard }, tries: 0 }, undefined, shops);
      case 'calc': return { answer: this.calc(reply) };
      case 'bhav': return this.bhav(phone, shopId, reply, books);
      default: break;
    }
    // Kinds that name a grahak: settle who, or ask, before the old handlers run.
    const needs = reply.kind === 'show' ? ((reply.views ?? []) as { view: string }[]).some((v) => v.view === 'udhaar')
      : (reply.kind === 'open' && reply.open === 'grahak_khata') || (reply.kind === 'download' && (reply.download as { report?: string })?.report === 'ledger')
        || ((reply.kind === 'edit') && !((reply.edit as { slip_no?: number })?.slip_no) && !!heard);
    if (needs && heard) {
      const r = this.who(heard, books, reply);
      if (r.kind === 'some') return this.askBuyer(s, { job: reply.kind as Pending['job'], data: { reply, heard } }, r.options, heard);
      if (r.kind === 'none') return this.notFound(s, shopId, heard, shops, { job: reply.kind as Pending['job'], data: { reply, heard } });
      reply.buyer = this.refOf(books, r.who.id); reply.buyer_name = r.who.name;
      s.focus = { buyerId: r.who.id, buyerName: r.who.name };
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
    if (reply.kind === 'query') out.answer = await this.answer(shopId, reply, lang);
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
  private async reply(q: Pending, body: z.infer<typeof PortalTurnBody>): Promise<{ value?: string; heard: string }> {
    if (body.pick) return { value: body.pick, heard: q.options?.find((o) => o.value === body.pick)?.label ?? body.pick };
    let heard = body.text?.trim() ?? '';
    if (!heard && body.audio) heard = await this.transcribe(q, body).catch(() => '');
    if (!heard) return { heard: '' };
    const yn = yesNo(heard);
    if (q.expect === 'phone') {
      const ph = phoneIn(heard);
      if (ph) return { value: ph, heard };
      if (yn === 'no') return { value: 'cancel', heard };
    }
    if (q.expect === 'yes' && yn) return { value: yn, heard };
    if (q.expect === 'choice' && q.options?.length) {
      if (/^(cancel|rehne|nahi|mat)/i.test(heard.trim()) || yn === 'no' && q.options.length <= 2) return { value: 'cancel', heard };
      const nth = ['pehla', 'pahla', 'first', 'ek', 'doosra', 'dusra', 'second', 'do', 'teesra', 'tisra', 'third', 'teen'].findIndex((w) => new RegExp(`\\b${w}\\b`, 'i').test(heard));
      if (nth >= 0) { const o = q.options[Math.floor(nth / 4)]; if (o) return { value: o.value, heard } }
      if (yn === 'yes' && q.options.length <= 3) return { value: q.options[0].value, heard };
      const best = q.options.map((o) => ({ o, sc: score(heard, { name: o.label.replace(/\(.*\)|·.*$/g, ''), code: '', phone: '' }) }))
        .sort((a, b) => b.sc - a.sc)[0];
      if (best && best.sc >= 0.6) return { value: best.o.value, heard };
    }
    return { heard };
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
    if (q.slot === 'buyer' && value) {
      if (value.startsWith('go:')) { const [, sid, bid] = value.split(':'); data.shopId = sid; data.buyerId = bid; }
      else if (value === 'new') data.newGrahak = true;
      else data.buyerId = value;
    }
    const target = data.shopId ?? shopId;
    // A pick for a job the old handlers run (show, open, download, edit, a draft): run it for that grahak.
    if (q.job !== 'whatsapp' && q.job !== 'call' && q.job !== 'grahak') {
      if (data.shopId && data.shopId !== shopId && data.buyerId) return { go: { shopId: data.shopId, buyerId: data.buyerId }, say: 'Us dukaan mein khol rahe hain' };
      const books = await this.books(shopId);
      if (data.newGrahak) { reply.buyer = 'new'; reply.buyer_name = data.heard; }
      else if (data.buyerId) { reply.buyer = this.refOf(books, data.buyerId); const b = books.buyers.get(String(reply.buyer)); reply.buyer_name = b?.name ?? reply.buyer_name; if (b) s.focus = { buyerId: b.id, buyerName: b.name }; }
      reply.heard = '';
      const p = await this.principal(phone, shopId);
      return { reply, ...(await this.route(phone, shopId, s, reply, books, 'hinglish', p, shops)) };
    }

    // whatsapp / call / grahak: who.
    const books = await this.books(target);
    const g = (reply.grahak ?? {}) as { name?: string; phone?: string; address?: string; code?: string; opening?: number; new?: boolean };
    if (!data.buyerId && !data.newGrahak) {
      if (q.job === 'grahak' && g.new) data.newGrahak = true;
      else {
        const r = data.heard ? this.who(data.heard, books, reply) : (s.focus.buyerId ? { kind: 'one' as const, who: books.buyers.get(this.refOf(books, s.focus.buyerId))!, sure: true } : { kind: 'none' as const });
        if (r.kind === 'some') return this.askBuyer(s, q, r.options, data.heard);
        if (r.kind === 'none' || !r.who) return this.notFound(s, target, data.heard || 'Grahak', shops, q);
        data.buyerId = r.who.id;
      }
    }
    // A new grahak: made now, with what was said (a number, purana udhaar).
    if (data.newGrahak && !data.buyerId) {
      const name = (g.name || data.heard || '').trim();
      if (!name) { s.pending = { ...q, expect: 'text', slot: 'name', question: 'Naye grahak ka naam boliye', tries: 0 }; return { ask: { question: 'Naye grahak ka naam boliye', expect: 'text', options: [] } }; }
      const exists = [...books.buyers.values()].find((b) => fold(b.name) === fold(name));
      if (exists) data.buyerId = exists.id;
      else {
        const made = await this.entries.grahak(phone, target, { name, phone: phoneIn(g.phone ?? '') ?? '', address: g.address ?? '', code: g.code ?? '', openingPaise: g.opening ? Math.round(g.opening * 100) : undefined });
        data.buyerId = made.id;
        this.cache.delete(target);
        if (q.job === 'grahak') { s.focus = { buyerId: made.id, buyerName: name }; return { say: `Naya grahak ${name} ban gaya${g.phone ? `, number ${g.phone}` : ''}`, saved: { buyerId: made.id } }; }
      }
    }
    if (q.slot === 'name' && value && !data.buyerId) { g.name = value; reply.grahak = g; return this.advance(phone, shopId, s, { ...q, slot: 'buyer' }, undefined, shops); }
    const fresh = await this.books(target, data.newGrahak);
    const b = [...fresh.buyers.values()].find((x) => x.id === data.buyerId);
    if (!b) return this.notFound(s, target, data.heard || 'Grahak', shops, q);
    s.focus = { buyerId: b.id, buyerName: b.name };

    // grahak: save what they said on it.
    if (q.job === 'grahak') {
      const ph = g.phone ? phoneIn(g.phone) : null;
      if (g.phone && !ph) { s.pending = { ...q, data: { ...data }, expect: 'phone', slot: 'phone', question: `${b.name} ka 10 ank ka mobile number boliye`, tries: 0 }; return { ask: { question: s.pending.question, expect: 'phone', options: [] } }; }
      const patch = { ...(ph ? { phone: ph } : {}), ...(g.address ? { address: g.address } : {}), ...(g.code ? { code: g.code } : {}) };
      if (q.slot === 'phone' && value && phoneIn(value)) Object.assign(patch, { phone: phoneIn(value)! });
      if (!Object.keys(patch).length) { s.pending = { ...q, data: { ...data }, expect: 'phone', slot: 'phone', question: `${b.name} ka mobile number boliye`, tries: 0 }; return { ask: { question: s.pending.question, expect: 'phone', options: [] } }; }
      await this.entries.updateGrahak(phone, target, b.id, patch);
      this.cache.delete(target);
      return { say: `${b.name}: ${patch.phone ? `number ${patch.phone}` : ''}${patch.address ? ` pata ${patch.address}` : ''} save ho gaya`.replace(/\s+/g, ' '), saved: { buyerId: b.id } };
    }

    // Nothing to send, or no way to send it: say so before asking for a number that would not help.
    if (q.job === 'whatsapp' && !this.alerts.canSend()) return { say: 'WhatsApp abhi chalu nahi hai' };
    if (q.job === 'whatsapp' && b.balancePaise <= 0) return { say: `${b.name} ka koi udhaar baaki nahi hai` };

    // whatsapp / call need their number: ask once, save it on the grahak, carry on.
    let mobile = /^[6-9]\d{9}$/.test(b.phone) ? b.phone : '';
    if (!mobile && q.slot === 'phone' && value) {
      const ph = phoneIn(value);
      if (ph) { await this.entries.updateGrahak(phone, target, b.id, { phone: ph }); this.cache.delete(target); mobile = ph; }
    }
    if (!mobile) {
      const question = q.slot === 'phone' ? `Number 10 ank ka chahiye. ${b.name} ka mobile number phir se boliye` : `${b.name} ka mobile number save nahi hai. Number boliye`;
      if (q.slot === 'phone' && q.tries >= 2) return { say: 'Number samajh nahi aaya. Grahak ke khata mein number daal kar phir boliye.' };
      s.pending = { ...q, data: { ...data }, expect: 'phone', slot: 'phone', question, tries: q.slot === 'phone' ? q.tries + 1 : 0 };
      return { ask: { question, expect: 'phone', options: [] } };
    }
    if (q.job === 'call') return { call: { phone: mobile, name: b.name }, say: `${b.name} ko call laga rahe hain` };

    // whatsapp: their udhaar (and khata PDF) from the MandiPlus number, now.
    try {
      const sent = await this.alerts.sendNow(target, b.id, phone);
      const amt = `₹${Math.round(sent.duePaise / 100).toLocaleString('en-IN')}`;
      return { say: `${b.name} ko ${amt} udhaar${sent.withPdf ? ' aur khata' : ''} WhatsApp pe bhej diya`, sent: { buyerId: b.id, withPdf: sent.withPdf } };
    } catch (e) {
      return { say: (e as Error).message || 'WhatsApp nahi gaya, thodi der baad phir boliye' };
    }
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

  /** Today's bhav as said, each maal matched to the shop's own list. */
  private async bhav(phone: string, shopId: string, r: Reply, books: Books) {
    const rows = ((r.bhav ?? []) as { maal?: string; grade?: string; rate?: number }[]).filter((x) => x.rate && x.rate > 0);
    const set: { brandId: string; grade: '1' | '2' | '3'; ratePaise: number; label: string }[] = [];
    const missed: string[] = [];
    for (const x of rows) {
      const m = books.brands.map((b) => ({ b, sc: score(x.maal ?? '', { name: b.name, code: '', phone: '' }) })).sort((a, b) => b.sc - a.sc)[0];
      if (!m || m.sc < 0.6) { missed.push(x.maal ?? '?'); continue; }
      const grade = x.grade === 'II' ? '2' : x.grade === 'III' ? '3' : '1';
      set.push({ brandId: m.b.id, grade, ratePaise: Math.round(x.rate! * 100), label: `${m.b.name} ${x.grade ?? 'I'} ₹${x.rate}` });
    }
    if (!set.length) return { say: missed.length ? `${missed.join(', ')} maal list mein nahi mila` : 'Bhav samajh nahi aaya, maal aur rate boliye' };
    await this.entries.setBhav(phone, shopId, { rates: set.map(({ label: _l, ...x }) => x) });
    this.cache.delete(shopId);
    return { say: `Aaj ka bhav: ${set.map((x) => x.label).join(', ')}${missed.length ? ` (${missed.join(', ')} nahi mila)` : ''}`, saved: { bhav: set.length } };
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
    // Every grahak is matched by the server; the model reads only the ones that are live —
    // owing, new, or bought or paid in the last 120 days — so the request stays small and quick.
    let shown = 0;
    rows.rows.forEach((b, i) => {
      const ref = `b${i + 1}`;
      const bal = n(b.bal);
      buyers.set(ref, { id: b.id, name: b.name.trim(), code: b.code, phone: b.phone ?? '', balancePaise: bal });
      if (!b.active || shown >= 900) return;
      shown++;
      lines.push(`GRAHAK ${ref} | ${b.name.trim()}${b.code ? ` | code ${b.code}` : ''} | ${bal >= 0 ? `udhaar ${Math.round(bal / 100)}` : `jama ${Math.round(-bal / 100)}`}`);
    });
    if (opts.brands.length) lines.push(`MAAL: ${opts.brands.map((x) => x.name).join(', ')}`);
    lines.push(`PANNI: ${PANNI.join(', ')}`, `KATTA: ${KATTA.join(', ')} (10, 15 or 20 dana)`);
    const books = { text: lines.join('\n'), at: Date.now(), buyers, trucks, day, brands: opts.brands };
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
  private async answer(shopId: string, r: Reply, lang: string) {
    const q = (r.query ?? {}) as { sql?: string; title?: string };
    const title = q.title || r.say;
    let result;
    try {
      result = await ask(this.db, shopId, q.sql ?? '');
    } catch (e) {
      this.log(`query refused or failed: ${(e as Error).message} :: ${q.sql}`);
      return { title, columns: [], rows: [], say: lang === 'english' ? "Couldn't find that in the books" : 'Ye hisab nahi nikal paaye, alag tarah se poochiye', speak: 'ये हिसाब नहीं निकल पाए, अलग तरह से पूछिए' };
    }
    // One row of one or two figures says itself; only longer answers need the second call.
    const shown = result.columns ?? Object.keys(result.rows[0] ?? {}).filter((k) => k !== 'id' && !k.endsWith('_id'));
    if (result.rows.length <= 1 && shown.length <= 3) {
      const row = result.rows[0] ?? {};
      const fmt = (k: string, v: unknown) => (typeof v === 'number' && /rakam|udhaar|kharid|bikri|baaki|amount|rupay|total|kul|jama|cash|upi/i.test(k) ? `₹${Math.round(v).toLocaleString('en-IN')}` : String(v ?? ''));
      const say = result.rows.length ? `${title}: ${shown.map((k) => fmt(k, row[k])).filter(Boolean).join(', ')}` : `${title}: kuch nahi mila`;
      return { title, ...result, say, speak: say };
    }
    const said = await this.compose(r.transcript, title, result.rows, lang).catch(() => null);
    return { title, ...result, say: said?.say ?? title, speak: said?.speak ?? '' };
  }

  private async compose(question: string, title: string, rows: Record<string, unknown>[], lang: string) {
    const r = await this.gemini.generate({
      systemInstruction: { parts: [{ text: COMPOSE }] },
      contents: [{ role: 'user', parts: [{ text: `Language for "say": ${lang}\nQuestion: ${question}\nTitle: ${title}\nRows (${rows.length}): ${JSON.stringify(rows.slice(0, 15))}` }] }],
      generationConfig: {
        temperature: 0, maxOutputTokens: 300, responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object', properties: { say: { type: 'string' }, speak: { type: 'string' } }, required: ['say', 'speak'] },
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
      },
    }, undefined, 8_000);
    return JSON.parse(r.text) as { say: string; speak: string };
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

const COMPOSE = `You are Bolo, the voice assistant in a mandi shop's billing website. You get a trader's question and the rows the shop's books returned for it. Answer in one or two short sentences.
- "say": in the requested language (hinglish = Hindi words in Latin script; hindi = Devanagari; english = simple English). The direct answer first, with the exact names and numbers from the rows. Rupees as ₹ with Indian grouping (₹1,25,000), no paise unless they are not zero. Dates as "15 Oct".
- "speak": the same answer in Hindi, Devanagari script, for a Hindi voice to read: numbers as digits with Indian grouping followed by "रुपये" for money; names as they are.
- Several rows: name at most the top three and say how many there are in all. No rows: say nothing matched.
- Never state a number, name or date that is not in the rows. No advice, no greetings.`;
