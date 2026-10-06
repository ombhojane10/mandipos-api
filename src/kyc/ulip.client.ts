import { Injectable, Logger } from '@nestjs/common';
import * as https from 'node:https';
import { config } from '../config';
import { createConnectProxyAgent } from './ulip-proxy-agent';

const TIMEOUT_MS = 45_000;
// ULIP tokens last longer, but a fresh login is cheap and a stale one fails mid-KYC.
const TOKEN_TTL_MS = 20 * 60_000;

/** A ULIP call that failed: the network, the gateway, or the department behind it. */
export class UlipError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

/**
 * ULIP (the logistics ministry's API gateway): login at /user/login, then POST each API with
 * the bearer token. Calls go out through the Mumbai proxy (ULIP only answers whitelisted Indian
 * IPs); TLS runs inside the CONNECT tunnel, so the proxy never sees Aadhaar data.
 *
 * ULIP wraps a department's answer as { response: [{ response: {...} }] } with HTTP 200 even
 * when the department refused, so [post] returns that inner object and callers read it.
 */
@Injectable()
export class UlipClient {
  private readonly log = new Logger('Ulip');
  private token: { value: string; at: number } | null = null;
  private agent: https.Agent | undefined;

  get configured(): boolean {
    const c = config();
    return !!(c.ULIP_BASE_URL && c.ULIP_USERNAME && c.ULIP_PASSWORD);
  }

  /** The staging gateway: test data, test OTPs, never a real KYC. */
  get staging(): boolean {
    return /staging/i.test(config().ULIP_BASE_URL ?? '');
  }

  async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = await this.login();
    let res = await this.send(path, body, token);
    if (res.status === 401 || res.status === 403) {
      this.token = null;
      res = await this.send(path, body, await this.login());
    }
    const outer = res.json as { response?: unknown; message?: string; error?: string } | null;
    if (res.status !== 200 || !outer) {
      throw new UlipError(`${path}: HTTP ${res.status} ${typeof outer?.message === 'string' ? outer.message : ''}`.trim(), res.status);
    }
    const first = Array.isArray(outer.response) ? outer.response[0] : outer.response;
    const inner = (first as { response?: unknown } | undefined)?.response ?? first;
    if (!inner || typeof inner !== 'object') {
      throw new UlipError(`${path}: ${typeof outer.message === 'string' ? outer.message : 'empty answer'}`, res.status);
    }
    return inner as Record<string, unknown>;
  }

  private async login(): Promise<string> {
    if (this.token && Date.now() - this.token.at < TOKEN_TTL_MS) return this.token.value;
    const c = config();
    const res = await this.send('/user/login', { username: c.ULIP_USERNAME, password: c.ULIP_PASSWORD }, null);
    const id = (res.json as { response?: { id?: unknown } } | null)?.response?.id;
    if (typeof id !== 'string' || !id) {
      this.log.warn(`ULIP login failed: HTTP ${res.status}`);
      throw new UlipError(`login: HTTP ${res.status}`, res.status);
    }
    this.token = { value: id, at: Date.now() };
    return id;
  }

  private send(path: string, body: unknown, token: string | null): Promise<{ status: number; json: unknown }> {
    const c = config();
    const url = new URL(c.ULIP_BASE_URL!.replace(/\/+$/, '') + path);
    const payload = Buffer.from(JSON.stringify(body));
    if (c.ULIP_PROXY_URL && !this.agent) this.agent = createConnectProxyAgent(c.ULIP_PROXY_URL, TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        agent: this.agent,
        timeout: TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': payload.length,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* an HTML error page */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      req.on('timeout', () => req.destroy(new UlipError(`${path}: timed out`)));
      req.on('error', (e) => reject(e instanceof UlipError ? e : new UlipError(`${path}: ${e.message}`)));
      req.end(payload);
    });
  }
}
