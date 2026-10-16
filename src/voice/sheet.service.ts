import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { requireShop } from '../auth/auth.guard';
import { Principal } from '../auth/tokens.service';
import { GeminiClient } from './gemini.client';
import { clean } from './voice.service';

/**
 * Udhaar bhav from a photo. At the end of the day the shop writes the rates for the day's udhaar
 * slips (written without bhav) on paper; the admin photographs that sheet — one page or several —
 * and every written entry comes back matched to its slip, for the app to show, correct and save.
 * The model only reads and matches; the app writes nothing until the admin taps Save.
 */
export const SheetBody = z.object({
  // Pages as JPEG, already shrunk by the app (~1600 px, ~200 KB each).
  images: z.array(z.string().min(100).max(2_500_000)).min(1).max(6),
  // The shop's udhaar slips still without bhav: "PARCHI p3 | #761 | 15 Oct | SBC C-112 | I 250, II 50".
  context: z.string().max(80_000),
});

const n = { type: 'number' };
const nullable = (t: object) => ({ anyOf: [t, { type: 'null' }] });
const ROW = {
  type: 'object',
  properties: {
    slip: nullable({ type: 'string' }),
    slip_no: nullable({ type: 'integer' }),
    grahak: nullable({ type: 'string' }),
    dana: nullable({ type: 'integer' }),
    bhav: nullable(n),
    bhav_ii: nullable(n),
    bhav_iii: nullable(n),
    amount: nullable(n),
  },
  required: ['slip', 'slip_no', 'grahak', 'dana', 'bhav', 'bhav_ii', 'bhav_iii', 'amount'],
};
const SCHEMA = { type: 'object', properties: { rows: { type: 'array', items: ROW } }, required: ['rows'] };

const PROMPT = `
You read a handwritten "udhaar bhav" sheet from a wholesale fruit shop in an Indian mandi (tender coconut by the piece, or guava by the box). During the day the shop wrote udhaar (credit) slips without a rate; at the end of the day someone writes, on paper, the rate (bhav) for each of those slips. You get photos of that sheet (one or more pages, in order) and the list of the shop's slips that still have no rate.

The sheet: one entry per slip, usually a slip (parchi) number, the grahak's name or code, the dana (pieces) and the bhav (rupees per piece), sometimes the amount (rakam) instead of or besides the bhav. Writing is quick and messy, in Hindi or English or mixed; digits may be Devanagari (१२३) or Latin; "x", "@", "×" or "ka" separate dana and bhav ("250 x 50", "250 @ 50", "250 ka 50"); a slip with grades may list several rates ("I 50 II 40", "1st 50 / 2nd 40"). Ignore totals, signatures, dates and crossed-out lines (but use the corrected value written next to a crossing-out).

The slips (refs p1, p2, ...):
- PARCHI p3 | #761 | 15 Oct | SBC C-112 | I 250, II 50  — ref, slip number, day, grahak, dana per grade.

For every entry written on the sheet, return a row:
- slip: the ref of the slip it is for. Match by the slip number first; if no number is written, by the grahak name/code AND the dana together. Use each slip at most once. "" if nothing matches confidently — never guess.
- slip_no, grahak, dana: as written (null if not written).
- bhav: the rate for grade I, or the single rate for the whole slip. bhav_ii / bhav_iii: only when a separate rate is written for that grade.
- amount: the rupee amount if written.
Copy numbers exactly as written; never invent a rate. If a number is unreadable, leave it null. Output only the JSON.
`.trim();

@Injectable()
export class SheetService {
  private readonly log = new Logger('Sheet');

  constructor(private readonly gemini: GeminiClient) {}

  async read(p: Principal, b: z.infer<typeof SheetBody>) {
    requireShop(p);
    const t0 = Date.now();
    const r = await this.gemini.generate({
      systemInstruction: { parts: [{ text: PROMPT }] },
      contents: [{
        role: 'user',
        parts: [
          { text: `# Slips without bhav\n${b.context.trim() || '(none)'}\n\n# The sheet (${b.images.length} page${b.images.length > 1 ? 's' : ''}) follows` },
          ...b.images.map((data) => ({ inlineData: { mimeType: 'image/jpeg', data } })),
        ],
      }],
      generationConfig: {
        temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json', responseJsonSchema: SCHEMA,
        // Reading handwriting is where a little thinking pays; it is one call at day's end.
        thinkingConfig: { thinkingLevel: 'LOW' },
      },
    }, undefined, 45_000, { hedgeMs: 15_000, firstMs: 30_000 });
    let rows: Record<string, unknown>[] = [];
    try {
      const parsed = JSON.parse(r.text) as { rows?: unknown[] };
      rows = (parsed.rows ?? []).map((x) => (clean(x) ?? {}) as Record<string, unknown>);
    } catch {
      this.log.warn(`unreadable sheet reply: ${r.text.slice(0, 200)}`);
    }
    this.log.log(`${p.shopId?.slice(0, 8)} sheet ${b.images.length}p → ${rows.length} rows, ${Date.now() - t0}ms in=${r.tokensIn} out=${r.tokensOut}`);
    return { rows, ms: Date.now() - t0 };
  }
}
