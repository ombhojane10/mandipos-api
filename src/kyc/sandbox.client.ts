import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { DigilockerProvider, DlAadhaar, DlPan, DlSession, DlStatus, ProviderError, panNumberIn } from './digilocker.provider';
import { parseEAadhaar } from './eaadhaar';

const TIMEOUT_MS = 30_000;
// Sandbox access tokens last 24 hours; take a fresh one well before that.
const TOKEN_TTL_MS = 20 * 3600_000;

/**
 * Sandbox.co.in's DigiLocker API. POST /authenticate (x-api-key + x-api-secret) gives a JWT
 * sent as Authorization without "Bearer". A session opens DigiLocker's sign-in page with
 * mobile + OTP and PIN-less login; status says when the grahak has allowed sharing and which
 * documents; each document fetch (₹1 + GST) answers a short-lived link to the issued file —
 * Aadhaar as UIDAI's signed XML (parsed here like the ULIP path), PAN as an XML Certificate.
 * Session, status and profile are free. Docs: developer.sandbox.co.in/api-reference/kyc/digilocker.
 */
@Injectable()
export class SandboxDigilockerClient implements DigilockerProvider {
  private readonly log = new Logger('SandboxDigilocker');
  private token: { value: string; at: number } | null = null;

  get configured(): boolean {
    const c = config();
    return !!(c.SANDBOX_API_KEY && c.SANDBOX_API_SECRET);
  }

  get source(): string {
    return /test-api/.test(config().SANDBOX_BASE_URL) ? 'sandbox-test' : 'sandbox';
  }

  async initialize(o: { mobile?: string; redirectUrl: string; state: string }): Promise<DlSession> {
    const d = await this.call('POST', '/kyc/digilocker/sessions/init', {
      '@entity': 'in.co.sandbox.kyc.digilocker.session.request',
      // Sign in with mobile + OTP, PIN-less; first-timers get DigiLocker's "Sign up" link there.
      flow: 'signin',
      redirect_url: o.redirectUrl,
      doc_types: ['aadhaar', 'pan'],
      options: { pinless: true },
    });
    const clientId = str(d.session_id);
    const url = str(d.authorization_url);
    if (!clientId || !url) throw new ProviderError('session init returned no session_id/authorization_url');
    return { clientId, url, expirySeconds: 600 };
  }

  async status(clientId: string): Promise<DlStatus> {
    const d = await this.call('GET', `/kyc/digilocker/sessions/${encodeURIComponent(clientId)}/status`);
    const status = str(d.status);
    const documents = Array.isArray(d.documents_consented) ? d.documents_consented.map(String) : [];
    return {
      completed: status === 'succeeded',
      failed: status === 'failed' || status === 'expired',
      aadhaarLinked: documents.includes('aadhaar'),
      documents,
      error: status === 'expired' ? 'DigiLocker session expired. Start eKYC again.' : '',
    };
  }

  async aadhaar(clientId: string): Promise<DlAadhaar> {
    const file = await this.document(clientId, 'aadhaar');
    if (!file) throw new ProviderError('Aadhaar not in DigiLocker', 404);
    const e = parseEAadhaar(file.toString('utf8'));
    if (!e) throw new ProviderError('Aadhaar file unreadable');
    // The DigiLocker account's mobile (free); the Aadhaar XML doesn't carry one.
    const profile = await this.call('GET', `/kyc/digilocker/sessions/${encodeURIComponent(clientId)}/user/profile`).catch(() => ({} as Record<string, unknown>));
    return {
      last4: e.last4, name: e.name, dob: e.dob, gender: e.gender, careOf: e.careOf, address: e.address,
      pincode: e.pincode, photo: e.photo, mobile: str(profile.mobile).replace(/\D/g, '').slice(-10), proof: file,
    };
  }

  async pan(clientId: string, status: DlStatus): Promise<DlPan> {
    // Each fetch is charged: only ask when the grahak shared a PAN.
    if (!status.documents.includes('pan')) return { status: 'none', number: '', note: '', file: null };
    const file = await this.document(clientId, 'pan');
    if (!file) return { status: 'none', number: '', note: '', file: null };
    const number = panNumberIn(file);
    return number ? { status: 'verified', number, note: '', file } : { status: 'failed', number: '', note: 'PAN record unreadable', file };
  }

  /** The issued file for a consented document, or null when DigiLocker has none (404). */
  private async document(clientId: string, docType: 'aadhaar' | 'pan'): Promise<Buffer | null> {
    let d: Record<string, unknown>;
    try {
      d = await this.call('GET', `/kyc/digilocker/sessions/${encodeURIComponent(clientId)}/documents/${docType}`);
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return null;
      throw err;
    }
    const files = Array.isArray(d.files) ? (d.files as { url?: string; metadata?: { ContentType?: string } }[]) : [];
    const pick = files.find((f) => /xml/i.test(f.metadata?.ContentType ?? '')) ?? files[0];
    if (!pick?.url || !/^https:\/\//.test(pick.url)) throw new ProviderError(`${docType}: no file link`);
    const r = await fetch(pick.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new ProviderError(`${docType} download: HTTP ${r.status}`, r.status);
    return Buffer.from(await r.arrayBuffer());
  }

  private async auth(force = false): Promise<string> {
    if (!force && this.token && Date.now() - this.token.at < TOKEN_TTL_MS) return this.token.value;
    const c = config();
    const res = await this.raw('POST', '/authenticate', undefined, { 'x-api-key': c.SANDBOX_API_KEY!, 'x-api-secret': c.SANDBOX_API_SECRET! });
    const t = str((res.json?.data as Record<string, unknown> | undefined)?.access_token);
    if (!res.ok || !t) {
      this.log.warn(`authenticate: HTTP ${res.status} ${res.json?.message ?? ''}`);
      throw new ProviderError(`authenticate: HTTP ${res.status}`, res.status === 200 ? 401 : res.status);
    }
    this.token = { value: t, at: Date.now() };
    return t;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
    const key = config().SANDBOX_API_KEY!;
    let res = await this.raw(method, path, body, { Authorization: await this.auth(), 'x-api-key': key });
    if (res.status === 401 || res.status === 403) res = await this.raw(method, path, body, { Authorization: await this.auth(true), 'x-api-key': key });
    const code = typeof res.json?.code === 'number' ? (res.json.code as number) : res.status;
    if (!res.ok || code >= 400) {
      const msg = str(res.json?.message) || `HTTP ${res.status}`;
      this.log.warn(`${method} ${path.replace(/sessions\/[\w-]+/, 'sessions/<id>')}: ${res.status} ${msg}`);
      // 521 = no such session, 523 = session expired or consent not finished.
      throw new ProviderError(msg, code, '', code === 521 || code === 523);
    }
    return (res.json?.data && typeof res.json.data === 'object' ? res.json.data : {}) as Record<string, unknown>;
  }

  private async raw(method: string, path: string, body: unknown, headers: Record<string, string>): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
    try {
      const r = await fetch(config().SANDBOX_BASE_URL.replace(/\/+$/, '') + path, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-version': '1.0', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { ok: r.ok, status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
    } catch (err) {
      throw new ProviderError(`${path}: ${(err as Error).message}`);
    }
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
