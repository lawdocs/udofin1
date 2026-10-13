import { exportJWK, generateKeyPair, createLocalJWKSet, SignJWT, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier, TokenError } from '../src/auth/token-verifier.js';

const ISSUER = 'https://project.supabase.co/auth/v1';
const USER = '0f0f0f0f-0000-4000-8000-000000000001';

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let good: KeyPair;
let other: KeyPair;
let goodJwk: JWK;

beforeAll(async () => {
  good = await generateKeyPair('ES256');
  other = await generateKeyPair('ES256');
  goodJwk = { ...(await exportJWK(good.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
});

const verifier = (jwks: JWK[] = [goodJwk]) =>
  createTokenVerifier({
    issuer: ISSUER,
    audience: 'authenticated',
    keys: createLocalJWKSet({ keys: jwks }),
  });

async function sign(
  overrides: {
    aud?: string;
    iss?: string;
    exp?: string | number;
    claims?: Record<string, unknown>;
    key?: KeyPair;
    kid?: string;
  } = {},
): Promise<string> {
  return new SignJWT({ role: 'authenticated', aal: 'aal2', ...overrides.claims })
    .setProtectedHeader({ alg: 'ES256', kid: overrides.kid ?? 'k1' })
    .setSubject(USER)
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? '10m')
    .sign((overrides.key ?? good).privateKey);
}

const bearer = (token: string) => `Bearer ${token}`;
const reason = async (header: string | undefined, v = verifier()) =>
  v.verify(header).then(
    () => 'accepted',
    (e: unknown) => (e instanceof TokenError ? e.reason : 'other'),
  );

describe('token verification', () => {
  it('accepts a valid token and returns only identity and assurance level', async () => {
    const claims = await verifier().verify(bearer(await sign()));
    expect(claims).toEqual({ sub: USER, aal: 'aal2', sessionId: null });
  });

  it('defaults a missing aal claim to aal1', async () => {
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setSubject(USER)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(good.privateKey);
    expect((await verifier().verify(bearer(token))).aal).toBe('aal1');
  });

  it('rejects a missing or malformed Authorization header', async () => {
    expect(await reason(undefined)).toBe('missing');
    expect(await reason('Basic abc')).toBe('missing');
    expect(await reason('Bearer ')).toBe('missing');
  });

  it('rejects the wrong audience', async () => {
    expect(await reason(bearer(await sign({ aud: 'anon' })))).toBe('invalid');
  });

  it('rejects the wrong issuer', async () => {
    expect(await reason(bearer(await sign({ iss: 'https://evil.example/auth/v1' })))).toBe(
      'invalid',
    );
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(await reason(bearer(await sign({ exp: past })))).toBe('expired');
  });

  it('rejects a token signed by an unknown key', async () => {
    expect(await reason(bearer(await sign({ key: other })))).toBe('invalid');
    expect(await reason(bearer(await sign({ kid: 'unknown' })))).toBe('invalid');
  });

  it('rejects alg none', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        sub: USER,
        iss: ISSUER,
        aud: 'authenticated',
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url');
    expect(await reason(bearer(`${header}.${body}.`))).toBe('invalid');
  });

  it('rejects a shared-secret (HS256) token even if the secret is the public key material', async () => {
    const secret = new TextEncoder().encode(JSON.stringify(goodJwk));
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject(USER)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(secret);
    expect(await reason(bearer(token))).toBe('invalid');
  });

  it('rejects tokens whose role is not authenticated or whose subject is not a uuid', async () => {
    expect(await reason(bearer(await sign({ claims: { role: 'service_role' } })))).toBe('invalid');
    expect(await reason(bearer(await sign({ claims: { role: 'anon' } })))).toBe('invalid');
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setSubject('not-a-uuid')
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(good.privateKey);
    expect(await reason(bearer(token))).toBe('invalid');
  });

  it('follows key rotation: a new key id works once published, the retired one stops working', async () => {
    const next = await generateKeyPair('ES256');
    const nextJwk = { ...(await exportJWK(next.publicKey)), kid: 'k2', alg: 'ES256', use: 'sig' };
    const token = await sign({ key: next, kid: 'k2' });
    expect(await reason(bearer(token), verifier([goodJwk]))).toBe('invalid');
    expect(await reason(bearer(token), verifier([goodJwk, nextJwk]))).toBe('accepted');
    const old = await sign();
    expect(await reason(bearer(old), verifier([nextJwk]))).toBe('invalid');
  });
});
