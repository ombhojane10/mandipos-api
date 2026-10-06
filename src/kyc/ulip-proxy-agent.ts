import * as http from 'node:http';
import * as https from 'node:https';
import type { Duplex } from 'node:stream';
import * as tls from 'node:tls';

/**
 * HTTPS agent that tunnels through an HTTP forward proxy with CONNECT.
 *
 * ULIP only accepts whitelisted source IPs located in India, while the backend
 * runs on Render in Singapore, so ULIP traffic goes through a small proxy in
 * GCP Mumbai. TLS is negotiated with ULIP inside the tunnel, so the proxy never
 * sees the ULIP password, tokens or RC data. Built on node:http and node:tls to
 * avoid adding a dependency.
 */
export function createConnectProxyAgent(
  proxyUrl: string,
  timeoutMs: number,
): https.Agent {
  const proxy = new URL(proxyUrl);
  const authorization = proxy.username
    ? `Basic ${Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
      ).toString('base64')}`
    : null;
  const agent = new https.Agent({ keepAlive: false });

  // http.Agent accepts a callback-style createConnection; returning undefined
  // tells it the socket will arrive through the callback.
  (agent as any).createConnection = (
    options: { host?: string; port?: number | string; servername?: string; rejectUnauthorized?: boolean },
    callback: (error: Error | null, socket?: Duplex) => void,
  ) => {
    const target = `${options.host}:${options.port || 443}`;
    let settled = false;
    const finish = (error: Error | null, socket?: Duplex) => {
      if (settled) return;
      settled = true;
      callback(error, socket);
    };

    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: target,
      headers: {
        Host: target,
        ...(authorization ? { 'Proxy-Authorization': authorization } : {}),
      },
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('ULIP proxy CONNECT timed out'));
    });
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        finish(new Error(`ULIP proxy CONNECT failed: HTTP ${response.statusCode}`));
        return;
      }
      request.setTimeout(0);
      finish(
        null,
        tls.connect({
          socket,
          servername: options.servername || options.host,
          rejectUnauthorized: options.rejectUnauthorized !== false,
        }),
      );
    });
    request.once('error', (error) => finish(error));
    request.end();
    return undefined;
  };

  return agent;
}
