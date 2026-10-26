import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { config } from '../config';

export interface GeminiResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

class GeminiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Gemini on Vertex AI over plain REST — the same project and API key the MandiPlus backend uses.
 *
 * Built for a person standing at the counter waiting: one call is usually 1.5–2.5 s, but now and
 * then a call hangs for 10 s or more. So the request is hedged — if the first has not answered by
 * VOICE_HEDGE_MS a second identical one goes out and whichever answers first wins (the other is
 * aborted) — and only when both fail does the fallback model get the rest of the time.
 *
 * A 429 means the model's shared Vertex quota is full for a moment: asking the same model again
 * is asking the same full pool, so it goes straight to the fallback — a different model, with
 * its own pool (2026-10-26: "hitesh balance" failed three times over on 3.6-flash's 429s).
 */
@Injectable()
export class GeminiClient {
  private readonly log = new Logger('Gemini');

  get enabled(): boolean {
    const c = config();
    return !!c.GEMINI_VERTEX_API_KEY && !!c.GEMINI_VERTEX_PROJECT_ID;
  }

  /** [fallbackPayload]: what the fallback model is sent instead, when it needs a lighter request. */
  async generate(
    payload: object, fallbackPayload: object = payload, budgetMs = 14_000,
    /** A slower call (photos to read) hedges later and gives its first try longer. */
    opts: { hedgeMs?: number; firstMs?: number } = {},
  ): Promise<GeminiResult> {
    if (!this.enabled) throw new ServiceUnavailableException('Voice is not switched on');
    const c = config();
    const deadline = Date.now() + budgetMs;
    try {
      // The hedged pair gets at most 8 s, so a call that hangs still leaves the retry time to answer.
      return await this.hedged(c.VOICE_MODEL, payload, opts.hedgeMs ?? c.VOICE_HEDGE_MS, Math.min(deadline, Date.now() + (opts.firstMs ?? 8_000)));
    } catch (e) {
      // Then the fallback model, and while time is left the two in turn: a 429 is a busy moment
      // on one model's pool, and the other's — or the same one a second later — often has room.
      let last = e;
      for (let i = 0; ; i++) {
        if (i > 0 && (last as GeminiError).status === 429) await sleep(Math.min(300 * i, 1_000));
        const left = deadline - Date.now();
        if (left < 1_500) throw this.unavailable(last);
        const fallback = i % 2 === 0;
        const model = fallback ? c.VOICE_FALLBACK_MODEL : c.VOICE_MODEL;
        this.log.warn(`${(last as Error).message}; trying ${model}`);
        try {
          return await this.once(model, fallback ? fallbackPayload : payload, AbortSignal.timeout(left));
        } catch (e2) {
          last = e2;
        }
      }
    }
  }

  /**
   * Speech for an answer: Gemini TTS, streamed. Yields raw 16-bit mono PCM at 24 kHz as it is made,
   * so the first sound plays in about a second instead of after the whole clip (~2 s).
   */
  async *speak(text: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    if (!this.enabled) throw new ServiceUnavailableException('Voice is not switched on');
    const c = config();
    const loc = c.GEMINI_VERTEX_LOCATION;
    const host = loc === 'global' ? 'https://aiplatform.googleapis.com' : `https://${loc}-aiplatform.googleapis.com`;
    const res = await fetch(`${host}/v1/projects/${encodeURIComponent(c.GEMINI_VERTEX_PROJECT_ID!)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(c.VOICE_TTS_MODEL)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'x-goog-api-key': c.GEMINI_VERTEX_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: c.VOICE_TTS_VOICE } } } },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!res.ok || !res.body) throw new GeminiError(`tts ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`, res.status);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let cut: RegExpExecArray | null;
      while ((cut = /\r?\n\r?\n/.exec(buf))) {
        const event = buf.slice(0, cut.index).replace(/^data: ?/, '');
        buf = buf.slice(cut.index + cut[0].length);
        const data = (JSON.parse(event || '{}') as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] })
          .candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (data) yield Buffer.from(data, 'base64');
      }
    }
  }

  private unavailable(e: unknown): Error {
    this.log.error(`voice model failed: ${(e as Error).message}`);
    return new ServiceUnavailableException('Abhi samajh nahi paaye, dobara boliye');
  }

  /** The first of up to two identical calls to answer; the second starts only if the first is slow. */
  private hedged(model: string, payload: object, hedgeMs: number, deadline: number): Promise<GeminiResult> {
    return new Promise((resolve, reject) => {
      const aborts: AbortController[] = [];
      let failures = 0;
      let started = 0;
      let done = false;
      const timer = setTimeout(() => fire('hedge'), hedgeMs);
      const finish = () => { done = true; clearTimeout(timer); aborts.forEach((a) => a.abort()); };
      const fire = (why: string) => {
        if (done || started >= 2) return;
        started++;
        if (why === 'hedge') this.log.warn(`${model} slow after ${hedgeMs} ms, hedging`);
        const ctl = new AbortController();
        aborts.push(ctl);
        const signal = AbortSignal.any([ctl.signal, AbortSignal.timeout(Math.max(1_000, deadline - Date.now()))]);
        this.once(model, payload, signal).then(
          (r) => { if (!done) { finish(); resolve(r); } },
          (e: unknown) => {
            if (done) return;
            failures++;
            this.log.warn(`attempt failed: ${(e as Error).message}`);
            // The quota is full: the fallback model, with its own quota, answers instead.
            if ((e as GeminiError).status === 429) { finish(); reject(e); }
            // Any other quick failure retries instead of waiting out the timer.
            else if (started < 2) fire('retry');
            else if (failures >= started) { finish(); reject(e); }
          },
        );
      };
      fire('first');
    });
  }

  private async once(model: string, payload: object, signal: AbortSignal): Promise<GeminiResult> {
    const c = config();
    const loc = c.GEMINI_VERTEX_LOCATION;
    const host = loc === 'global' ? 'https://aiplatform.googleapis.com' : `https://${loc}-aiplatform.googleapis.com`;
    const url = `${host}/v1/projects/${encodeURIComponent(c.GEMINI_VERTEX_PROJECT_ID!)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': c.GEMINI_VERTEX_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      error?: { message?: string };
    };
    if (!res.ok) throw new GeminiError(`${model} ${res.status}: ${body.error?.message?.slice(0, 200) ?? ''}`, res.status);
    const cand = body.candidates?.[0];
    const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    if (!text) throw new GeminiError(`${model} returned nothing (${cand?.finishReason ?? 'no candidate'})`, 502);
    // JSON mode now and then runs away (whitespace or a repeated field) until the token cap. A
    // reply that was cut off or does not parse counts as a failure, so the other call or the
    // retry answers instead of the counter getting "unclear".
    if (cand?.finishReason === 'MAX_TOKENS' || !parses(text)) {
      throw new GeminiError(`${model} ran away (${cand?.finishReason}, ${body.usageMetadata?.candidatesTokenCount ?? '?'} tokens): ${text.slice(0, 120).replace(/\s+/g, ' ')}`, 502);
    }
    return {
      text,
      model,
      tokensIn: body.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: body.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}

function parses(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
