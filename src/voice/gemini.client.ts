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
 */
@Injectable()
export class GeminiClient {
  private readonly log = new Logger('Gemini');

  get enabled(): boolean {
    const c = config();
    return !!c.GEMINI_VERTEX_API_KEY && !!c.GEMINI_VERTEX_PROJECT_ID;
  }

  /** [fallbackPayload]: what the fallback model is sent instead, when it needs a lighter request. */
  async generate(payload: object, fallbackPayload: object = payload, budgetMs = 14_000): Promise<GeminiResult> {
    if (!this.enabled) throw new ServiceUnavailableException('Voice is not switched on');
    const c = config();
    const deadline = Date.now() + budgetMs;
    try {
      return await this.hedged(c.VOICE_MODEL, payload, c.VOICE_HEDGE_MS, deadline);
    } catch (e) {
      const left = deadline - Date.now();
      if (left < 1_500) throw this.unavailable(e);
      this.log.warn(`${c.VOICE_MODEL} failed (${(e as Error).message}); trying ${c.VOICE_FALLBACK_MODEL}`);
      try {
        return await this.once(c.VOICE_FALLBACK_MODEL, fallbackPayload, AbortSignal.timeout(left));
      } catch (e2) {
        throw this.unavailable(e2);
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
            // A quick failure (429, 5xx) hedges at once instead of waiting out the timer.
            if (started < 2) fire('retry');
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
    return {
      text,
      model,
      tokensIn: body.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: body.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}
