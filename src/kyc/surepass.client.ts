import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';

const TIMEOUT_MS = 30_000;

/** A Surepass call that failed: network, auth, or Surepass/DigiLocker refusing. */
export class SurepassError extends Error {
  constructor(message: string, readonly status = 0, readonly code = '') {
    super(message);
  }
}

export type SurepassAadhaar = {
  digilocker_metadata?: { name?: string; gender?: string; dob?: string; mobile_number?: string };
  aadhaar_xml_data?: {
    full_name?: string; care_of?: string; dob?: string; zip?: string; profile_image?: string; gender?: string;
    masked_aadhaar?: string; full_address?: string; father_name?: string | null;
  };
  xml_url?: string;
};

export type SurepassDocument = { file_id: string; doc_type: string; name?: string; file_type?: string; issuer?: string };

/**
 * Surepass's DigiLocker APIs (an authorised DigiLocker partner). initialize gives a hosted
 * DigiLocker page where the grahak signs in with their own mobile/Aadhaar and OTP; then
 * status, download-aadhaar (once per session), list-documents and download-document.
 * Docs: app.surepass.app/docs/kyc/digilocker-3588870f0. Bearer token from the console.
 */
@Injectable()
export class SurepassClient {
  private readonly log = new Logger('Surepass');

  get configured(): boolean {
    return !!config().SUREPASS_TOKEN;
  }

  get sandbox(): boolean {
    return /sandbox/i.test(config().SUREPASS_BASE_URL);
  }

  async initialize(opts: { mobile?: string; name?: string; redirectUrl: string; state: string }): Promise<{ clientId: string; url: string; expirySeconds: number }> {
    const prefill: Record<string, string> = {};
    if (opts.mobile) prefill.mobile_number = opts.mobile;
    if (opts.name) prefill.full_name = opts.name.slice(0, 250);
    const d = await this.call('POST', '/api/v1/digilocker/initialize', {
      data: {
        // false = "Sign In via DigiLocker": Mobile + OTP with PIN-less login, and "Sign up" (Aadhaar + OTP) for first-timers.
        signup_flow: false,
        skip_main_screen: true,
        aadhaar_xml: true,
        expiry_minutes: 10,
        redirect_url: opts.redirectUrl,
        state: opts.state.slice(0, 100),
        ...(Object.keys(prefill).length ? { prefill_options: prefill } : {}),
      },
    });
    const clientId = str(d.client_id);
    const url = str(d.url);
    if (!clientId || !url) throw new SurepassError('initialize returned no client_id/url');
    return { clientId, url, expirySeconds: Number(d.expiry_seconds) || 600 };
  }

  async status(clientId: string): Promise<{ completed: boolean; failed: boolean; aadhaarLinked: boolean; status: string; error: string }> {
    const d = await this.call('GET', `/api/v1/digilocker/status/${encodeURIComponent(clientId)}`);
    return { completed: d.completed === true, failed: d.failed === true, aadhaarLinked: d.aadhaar_linked === true, status: str(d.status), error: str(d.error_description) };
  }

  async downloadAadhaar(clientId: string): Promise<SurepassAadhaar> {
    return (await this.call('GET', `/api/v1/digilocker/download-aadhaar/${encodeURIComponent(clientId)}`)) as SurepassAadhaar;
  }

  async listDocuments(clientId: string): Promise<SurepassDocument[]> {
    const d = await this.call('GET', `/api/v1/digilocker/list-documents/${encodeURIComponent(clientId)}`);
    return Array.isArray(d.documents) ? (d.documents as SurepassDocument[]) : [];
  }

  /** A document's bytes (the link Surepass gives lasts ~10 minutes, so it is fetched at once). */
  async downloadDocument(clientId: string, fileId: string): Promise<Buffer> {
    const d = await this.call('GET', `/api/v1/digilocker/download-document/${encodeURIComponent(clientId)}/${encodeURIComponent(fileId)}`);
    return this.fetchBytes(str(d.download_url));
  }

  async fetchBytes(url: string): Promise<Buffer> {
    if (!/^https:\/\//.test(url)) throw new SurepassError('no download url');
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new SurepassError(`download: HTTP ${r.status}`, r.status);
    return Buffer.from(await r.arrayBuffer());
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
    const c = config();
    let res: Response;
    try {
      res = await fetch(c.SUREPASS_BASE_URL.replace(/\/+$/, '') + path, {
        method,
        headers: { Authorization: `Bearer ${c.SUREPASS_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new SurepassError(`${path}: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => null)) as { data?: unknown; message?: string; message_code?: string; success?: boolean } | null;
    if (!res.ok || !json || json.success === false) {
      const msg = json?.message ?? `HTTP ${res.status}`;
      this.log.warn(`${method} ${path.replace(/\/digilocker_[\w-]+/, '/<client>')}: ${res.status} ${json?.message_code ?? ''} ${msg}`);
      throw new SurepassError(msg, res.status, json?.message_code ?? '');
    }
    return (json.data && typeof json.data === 'object' ? json.data : {}) as Record<string, unknown>;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
