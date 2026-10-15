import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { requireShop } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { uuidv7 } from '../common/uuid';
import { config } from '../config';
import { Db } from '../db/db.service';
import { GeminiClient } from './gemini.client';
import { APP_GUIDE, FALLBACK_SCHEMA, RESPONSE_SCHEMA, SYSTEM_INSTRUCTION, userText } from './voice.prompt';

export const TurnBody = z
  .object({
    // ~30 s of 16 kHz mono AAC at 32 kbps is ~160 KB of base64; the 1 MB body limit is the cap.
    audio: z.string().max(900_000).optional(),
    mime: z.enum(['audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mpeg']).default('audio/mp4'),
    audioMs: z.number().int().min(0).max(120_000).default(0),
    // Typed instead of spoken: the eval script, and anyone who would rather type.
    text: z.string().max(500).optional(),
    // The shop's live books as the app sees them (gaadis, grahaks with udhaar, panni names...).
    context: z.string().max(120_000),
    screen: z.string().max(40).default('home'),
    draft: z.string().max(4_000).optional(),
    history: z.array(z.object({ q: z.string().max(500), a: z.string().max(500) })).max(4).optional(),
    lang: z.enum(['hinglish', 'hindi', 'english']).default('hinglish'),
  })
  .refine((b) => !!b.audio || !!b.text?.trim(), { message: 'audio or text is required', path: ['audio'] });

export const OutcomeBody = z.object({ outcome: z.enum(['saved', 'edited', 'discarded', 'opened']) });

export type Reply = { transcript: string; kind: string; say: string } & Record<string, unknown>;

/** Per-shop turns in the last minute; one API instance, so memory is enough. */
const recent = new Map<string, number[]>();

@Injectable()
export class VoiceService {
  private readonly log = new Logger('Voice');

  constructor(private readonly db: Db, private readonly gemini: GeminiClient) {}

  async turn(p: Principal, b: z.infer<typeof TurnBody>) {
    const shopId = requireShop(p);
    this.limit(shopId);
    const t0 = Date.now();
    const parts: object[] = [{ text: userText(b) }];
    if (b.audio && !b.text) parts.push({ inlineData: { mimeType: b.mime, data: b.audio } });
    const payload = {
      systemInstruction: { parts: [{ text: `${SYSTEM_INSTRUCTION}\n\n${APP_GUIDE}` }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
        responseJsonSchema: RESPONSE_SCHEMA,
        // Thinking costs a second or more and buys nothing for slot-filling.
        thinkingConfig: { thinkingLevel: config().VOICE_THINKING.toUpperCase() },
      },
    };

    const id = uuidv7();
    let reply: Reply;
    let model = '';
    let tokensIn = 0;
    let tokensOut = 0;
    try {
      // A lite fallback model is sent the loose schema; the same model keeps the strict one.
      const lite = /lite/.test(config().VOICE_FALLBACK_MODEL);
      const fallback = lite ? { ...payload, generationConfig: { ...payload.generationConfig, responseJsonSchema: FALLBACK_SCHEMA } } : payload;
      const r = await this.gemini.generate(payload, fallback);
      ({ model, tokensIn, tokensOut } = r);
      reply = this.read(r.text);
    } catch (e) {
      void this.record(p, shopId, id, b, null, model, Date.now() - t0, 0, 0, (e as Error).message);
      throw e;
    }
    const ms = Date.now() - t0;
    this.log.log(`${shopId.slice(0, 8)} ${reply.kind} ${ms}ms ${model} in=${tokensIn} out=${tokensOut} "${reply.transcript.slice(0, 80)}"`);
    // Written after the answer goes back: the counter is not kept waiting on the log.
    void this.record(p, shopId, id, b, reply, model, ms, tokensIn, tokensOut, null);
    return { id, reply, model, ms };
  }

  async outcome(p: Principal, id: string, outcome: string) {
    const shopId = requireShop(p);
    const n = await this.db.withShop(shopId, async (tx) =>
      (await tx.query(`UPDATE voice_turns SET outcome = $2 WHERE id = $1`, [id, outcome])).rowCount,
    );
    if (!n) throw new NotFoundException('No such voice turn');
    return { ok: true };
  }

  /** The model's JSON, or an "unclear" turn when it came back cut off or malformed. */
  private read(text: string): Reply {
    try {
      const o = JSON.parse(text) as Reply;
      if (o && typeof o === 'object' && typeof o.kind === 'string') {
        const c = (clean(o) ?? {}) as Reply;
        c.kind = o.kind;
        c.transcript = String(o.transcript ?? '');
        c.say = String(o.say ?? '');
        return c;
      }
    } catch {
      /* fall through */
    }
    this.log.warn(`unreadable reply: ${text.slice(0, 200)}`);
    return { transcript: '', kind: 'unclear', say: 'Samajh nahi aaya, dobara boliye' };
  }

  private limit(shopId: string) {
    const now = Date.now();
    const times = (recent.get(shopId) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= config().VOICE_PER_MINUTE) {
      throw new HttpException('Thoda ruk kar boliye', HttpStatus.TOO_MANY_REQUESTS);
    }
    times.push(now);
    recent.set(shopId, times);
  }

  private async record(
    p: Principal, shopId: string, id: string, b: z.infer<typeof TurnBody>, reply: Reply | null,
    model: string, ms: number, tokensIn: number, tokensOut: number, error: string | null,
  ) {
    try {
      await this.db.withShop(shopId, (tx) =>
        tx.query(
          `INSERT INTO voice_turns (id, shop_id, user_id, device_id, screen, transcript, kind, reply, model, audio_ms, latency_ms, tokens_in, tokens_out, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [id, shopId, p.userId, p.deviceId, b.screen, reply?.transcript ?? b.text ?? '', reply?.kind ?? '', JSON.stringify(reply ?? {}),
            model, b.audioMs, ms, tokensIn, tokensOut, error?.slice(0, 500) ?? null],
        ),
      );
    } catch (e) {
      this.log.warn(`voice turn not recorded: ${(e as Error).message}`);
    }
  }
}

/**
 * Largest believable value per field. Constrained decoding has been seen to emit 2.2e+307 for a
 * spoken "22"; a number outside these bounds is dropped, so the draft shows an empty box the
 * counter fills rather than a wrong one they might not notice.
 */
const BOUNDS: Record<string, number> = { qty: 100_000, kattas: 10_000, rate: 100_000, amount: 10_000_000, cash: 10_000_000, upi: 10_000_000 };

/** Drops what the model should have left out (blanks, zeros, false, empty lists) and any impossible number. */
export function clean(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) {
    const items = v.map((x) => clean(x)).filter((x) => x !== undefined);
    return items.length ? items : undefined;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const c = clean(x, k);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof v === 'number') {
    const max = BOUNDS[key] ?? 10_000_000;
    return Number.isFinite(v) && v > 0 && v <= max ? Math.round(v * 100) / 100 : undefined;
  }
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'boolean') return v || undefined;
  return undefined;
}
