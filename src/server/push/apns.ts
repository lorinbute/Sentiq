// FD-PUSH, TD-PUSH §2: Apple's push service (APNs) over HTTP/2 with a provider token (ES256 JWT from the team's .p8 key),
// no package: node's http2 and crypto. The key comes from the environment (App Service settings), never from a request.
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';

export type ApnsEnv = 'production' | 'sandbox';

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The .p8 key (PEM). */
  key: KeyObject;
  /** The app's bundle id. */
  topic: string;
}

/** What Apple answered: delivered, a token to forget (the app was removed, or the token is of the other service), or a failure. */
export type ApnsResult = { ok: true } | { ok: false; status: number; reason: string; gone: boolean; wrongEnv: boolean };

const HOSTS: Record<ApnsEnv, string> = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
/** Apple accepts a token 20–60 minutes old; a new one every 40. */
const TOKEN_MS = 40 * 60_000;

/**
 * The settings: APNS_KEY_ID, APNS_KEY (the .p8's text; its line breaks may be written "\n", or the whole file in base64),
 * APNS_TEAM_ID and APNS_TOPIC (the team and bundle by default). Null when the key is not set (push is off, logged once).
 */
export function apnsConfig(env: NodeJS.ProcessEnv, defaults: { teamId: string; topic: string }): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const raw = env.APNS_KEY?.trim();
  if (!keyId || !raw) return null;
  return { keyId, teamId: env.APNS_TEAM_ID?.trim() || defaults.teamId, key: readKey(raw), topic: env.APNS_TOPIC?.trim() || defaults.topic };
}

/**
 * The .p8 key however it was pasted into a one-line setting: the file's text (its line breaks lost to spaces, or written
 * "\n"), the whole file in base64, or the key's base64 alone (without its BEGIN / END lines).
 */
export function readKey(raw: string): KeyObject {
  let text = raw.trim();
  if (!text.includes('BEGIN')) {
    const decoded = Buffer.from(text.replace(/\s+/g, ''), 'base64');
    const asText = decoded.toString('utf8');
    if (!asText.includes('BEGIN')) return createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' });
    text = asText;
  }
  const body = text
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END)[A-Z ]*-----/g, '')
    .replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return createPrivateKey(`-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class Apns {
  private readonly cfg: ApnsConfig;
  private token: { value: string; at: number } | null = null;
  private readonly sessions = new Map<ApnsEnv, ClientHttp2Session>();

  constructor(cfg: ApnsConfig) {
    this.cfg = cfg;
  }

  private jwt(): string {
    const now = Date.now();
    if (this.token && now - this.token.at < TOKEN_MS) return this.token.value;
    const head = b64url(JSON.stringify({ alg: 'ES256', kid: this.cfg.keyId }));
    const claims = b64url(JSON.stringify({ iss: this.cfg.teamId, iat: Math.floor(now / 1000) }));
    const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key: this.cfg.key, dsaEncoding: 'ieee-p1363' });
    const value = `${head}.${claims}.${b64url(signature)}`;
    this.token = { value, at: now };
    return value;
  }

  private session(env: ApnsEnv): ClientHttp2Session {
    const s = this.sessions.get(env);
    if (s && !s.closed && !s.destroyed) return s;
    const fresh = connect(HOSTS[env]);
    fresh.on('error', () => this.sessions.delete(env));
    fresh.on('close', () => this.sessions.delete(env));
    // An idle connection does not keep the process alive.
    fresh.unref();
    this.sessions.set(env, fresh);
    return fresh;
  }

  /** One notification to one device. `collapseId`: a later one with the same id replaces it on the device. */
  send(env: ApnsEnv, token: string, payload: object, opts: { collapseId?: string; timeoutMs?: number } = {}): Promise<ApnsResult> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: ApnsResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      let req;
      try {
        req = this.session(env).request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          authorization: `bearer ${this.jwt()}`,
          'apns-topic': this.cfg.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          ...(opts.collapseId ? { 'apns-collapse-id': opts.collapseId.slice(0, 64) } : {}),
          'content-type': 'application/json',
        });
      } catch (err) {
        done({ ok: false, status: 0, reason: (err as Error).message, gone: false, wrongEnv: false });
        return;
      }
      let status = 0;
      let body = '';
      req.setTimeout(opts.timeoutMs ?? 15_000, () => {
        req.close();
        done({ ok: false, status: 0, reason: 'timeout', gone: false, wrongEnv: false });
      });
      req.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
      });
      req.setEncoding('utf8');
      req.on('data', (c: string) => {
        body += c;
      });
      req.on('end', () => {
        if (status === 200) return done({ ok: true });
        let reason = '';
        try {
          reason = String((JSON.parse(body) as { reason?: string }).reason ?? '');
        } catch {
          reason = body.slice(0, 120);
        }
        // 410: the app is gone from the device; BadDeviceToken: a token of the other service (development / production).
        done({ ok: false, status, reason, gone: status === 410 || reason === 'Unregistered', wrongEnv: reason === 'BadDeviceToken' });
      });
      req.on('error', (err) => done({ ok: false, status, reason: err.message, gone: false, wrongEnv: false }));
      req.end(JSON.stringify(payload));
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
