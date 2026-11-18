import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Apns, apnsConfig, readKey } from './apns.ts';
import { levelOf } from './service.ts';

// FD-PUSH: the .p8 key as it may be pasted into App Service's one-line settings.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const der = privateKey.export({ format: 'der', type: 'pkcs8' });

describe('APNs key (FD-PUSH)', () => {
  const forms: [string, string][] = [
    ['the file as it is', pem],
    ['its line breaks lost to spaces', pem.replace(/\n/g, ' ')],
    ['its line breaks written \\n', pem.replace(/\n/g, '\\n')],
    ['on one line, no breaks', pem.replace(/\n/g, '')],
    ['the whole file in base64', Buffer.from(pem).toString('base64')],
    ['the key alone in base64', der.toString('base64')],
  ];
  for (const [what, raw] of forms) {
    it(`reads ${what}`, () => {
      expect(readKey(raw).export({ format: 'der', type: 'pkcs8' }).equals(der)).toBe(true);
    });
  }

  it('signs a provider token Apple can verify (ES256, raw r|s)', () => {
    const cfg = apnsConfig({ APNS_KEY_ID: 'ABC123DEFG', APNS_KEY: pem.replace(/\n/g, ' ') } as NodeJS.ProcessEnv, { teamId: 'TEAM', topic: 'com.example' })!;
    const token = (new Apns(cfg) as unknown as { jwt(): string }).jwt();
    const [h, c, sig] = token.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString()).iss).toBe('TEAM');
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'))).toBe(true);
  });

  it('is off without a key', () => {
    expect(apnsConfig({} as NodeJS.ProcessEnv, { teamId: 'T', topic: 'x' })).toBeNull();
  });
});

describe('which level closed a position (FD-PUSH)', () => {
  it('the nearer level within its slack; neither: closed by hand', () => {
    expect(levelOf(110, 90, 110)).toBe('tp');
    expect(levelOf(109.2, 90, 110)).toBe('tp');
    expect(levelOf(88, 90, 110)).toBe('sl');
    expect(levelOf(100, 90, 110)).toBeNull();
    expect(levelOf(91, 90, null)).toBe('sl');
    expect(levelOf(105, null, 110)).toBeNull();
    expect(levelOf(null, 90, 110)).toBeNull();
  });
});
