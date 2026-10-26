import { GeminiClient } from '../src/voice/gemini.client';

jest.mock('../src/config', () => ({
  config: () => ({
    GEMINI_VERTEX_API_KEY: 'k', GEMINI_VERTEX_PROJECT_ID: 'p', GEMINI_VERTEX_LOCATION: 'global',
    VOICE_MODEL: 'main', VOICE_FALLBACK_MODEL: 'spare', VOICE_HEDGE_MS: 3000,
  }),
}));

/** Answers each Vertex call from [plan] in turn: a status, or 200 with a JSON reply. Records the model asked. */
function vertex(plan: number[]) {
  const asked: string[] = [];
  global.fetch = jest.fn(async (url: string) => {
    asked.push(/models\/([^:]+):/.exec(url)![1]);
    const status = plan.shift() ?? 429;
    const body = status === 200
      ? { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }] }
      : { error: { message: 'Resource exhausted' } };
    return { ok: status === 200, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return asked;
}

describe('Bolo on a full Vertex quota', () => {
  it('goes to the other model at once on a 429, and keeps taking turns while time is left', async () => {
    const asked = vertex([429, 429, 429, 200]);
    const r = await new GeminiClient().generate({});
    // Never the same full pool twice in a row.
    expect(asked).toEqual(['main', 'spare', 'main', 'spare']);
    expect(r.model).toBe('spare');
  });

  it('answers from the fallback model when only it has room', async () => {
    const asked = vertex([429, 200]);
    const r = await new GeminiClient().generate({});
    expect(asked).toEqual(['main', 'spare']);
    expect(r.model).toBe('spare');
  });

  it('gives up with the counter message once the budget is spent', async () => {
    vertex([]);
    await expect(new GeminiClient().generate({}, {}, 3_000)).rejects.toThrow('Abhi samajh nahi paaye');
  });
});
