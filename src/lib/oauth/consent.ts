// /oauth/authorize: request validation (shared by the consent page and its server action),
// the HMAC that binds a consent form to the exact params it showed, and authorization-code issuance.
import { getDb, schema } from '@/db';
import { resolveClient, type OAuthClient } from './clients';
import {
  TTL, checkResource, hashSecret, isValidChallenge, issuer, newSecret, parseScopes, redirectUriMatches,
  redirectUriProblem, safeEqual, scopeString, type Scope,
} from './core';

/** The authorize parameters we act on. Anything else in the query is ignored (RFC 6749 §3.1). */
export const AUTHORIZE_PARAMS = [
  'response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource',
] as const;
export type AuthorizeParam = (typeof AUTHORIZE_PARAMS)[number];
export type RawAuthorize = Partial<Record<AuthorizeParam, string>>;

export type ValidAuthorize = {
  client: OAuthClient;
  clientId: string;
  /** Exactly as sent; the token request must repeat this string. */
  redirectUri: string;
  codeChallenge: string;
  scopes: Scope[];
  /** Canonical audience (mcpResource()). */
  resource: string;
  state: string | null;
  raw: RawAuthorize;
};

export type AuthorizeCheck =
  | { ok: true; req: ValidAuthorize }
  /** client_id / redirect_uri unusable: show an error page, never redirect. */
  | { ok: false; fatal: string }
  /** Redirect to the (verified) redirect_uri with this error. */
  | { ok: false; redirect: string };

/**
 * Picks the authorize params from a query/form. A param given twice is an error (RFC 6749 §3.1),
 * reported as `duplicate` so the caller can refuse it.
 */
export function pickAuthorizeParams(get: (name: string) => string[]): { raw: RawAuthorize; duplicate: AuthorizeParam | null } {
  const raw: RawAuthorize = {};
  let duplicate: AuthorizeParam | null = null;
  for (const name of AUTHORIZE_PARAMS) {
    const values = get(name);
    if (values.length > 1) duplicate ??= name;
    if (values.length) raw[name] = values[0];
  }
  return { raw, duplicate };
}

/** Query string of the authorize params only, in a stable order. */
export function authorizeQuery(raw: RawAuthorize) {
  const q = new URLSearchParams();
  for (const name of AUTHORIZE_PARAMS) if (raw[name] !== undefined) q.set(name, raw[name]!);
  return q.toString();
}

/** Authorization response URL (RFC 6749 §4.1.2 + RFC 9207 `iss`), keeping any query the redirect URI already has. */
export function authorizationResponseUrl(redirectUri: string, params: Record<string, string | null | undefined>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  u.searchParams.set('iss', issuer());
  return u.toString();
}

const MAX_STATE = 2048;

/**
 * Validates an authorization request in the order of RFC 6749 §4.1.2.1: first client_id and redirect_uri
 * (failures there are never redirected), then everything else (failures redirect with `error`).
 */
export async function validateAuthorize(raw: RawAuthorize, duplicate: AuthorizeParam | null = null): Promise<AuthorizeCheck> {
  const clientId = raw.client_id;
  if (!clientId) return { ok: false, fatal: 'The request has no client_id.' };
  if (duplicate === 'client_id' || duplicate === 'redirect_uri') return { ok: false, fatal: `The request repeats ${duplicate}.` };
  const client = await resolveClient(clientId).catch(() => null);
  if (!client) return { ok: false, fatal: 'Unknown client. The app must register again (or its metadata document could not be loaded).' };

  const redirectUri = raw.redirect_uri;
  if (!redirectUri) return { ok: false, fatal: 'The request has no redirect_uri.' };
  if (redirectUriProblem(redirectUri) || !redirectUriMatches(client.redirectUris, redirectUri))
    return { ok: false, fatal: 'The redirect_uri is not registered for this client.' };

  const state = raw.state ?? null;
  const fail = (error: string, description: string): AuthorizeCheck => ({
    ok: false,
    redirect: authorizationResponseUrl(redirectUri, { error, error_description: description, state }),
  });

  if (duplicate) return fail('invalid_request', `${duplicate} must not be repeated`);
  if (state && state.length > MAX_STATE) return fail('invalid_request', 'state is too long');
  if (raw.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  if (raw.code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  if (!isValidChallenge(raw.code_challenge)) return fail('invalid_request', 'code_challenge must be a base64url S256 challenge');
  const resource = checkResource(raw.resource);
  if (!resource) return fail('invalid_target', 'resource must be this server\'s MCP endpoint');
  const scopes = parseScopes(raw.scope);
  if (!scopes) return fail('invalid_scope', 'supported scopes: read, write, admin');

  return { ok: true, req: { client, clientId: client.clientId, redirectUri, codeChallenge: raw.code_challenge, scopes, resource, state, raw } };
}

// ---------- signed consent ----------

const enc = new TextEncoder();
const SIG_TTL_MS = 10 * 60_000;

async function hmacHex(data: string) {
  const secret = process.env.STUDIO_SESSION_SECRET;
  if (!secret) throw new Error('STUDIO_SESSION_SECRET is not set');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, enc.encode(data))).toString('hex');
}

// Domain-separated from the session cookie HMAC; params JSON-encoded so values cannot run together.
const payload = (raw: RawAuthorize, exp: number) =>
  JSON.stringify(['oauth-consent-v1', exp, AUTHORIZE_PARAMS.map(n => raw[n] ?? null)]);

/** `<exp>.<hmac>` over the authorize params the consent form shows. Valid 10 minutes. */
export async function signConsent(raw: RawAuthorize) {
  const exp = Date.now() + SIG_TTL_MS;
  return `${exp}.${await hmacHex(payload(raw, exp))}`;
}

export async function verifyConsent(raw: RawAuthorize, sig: string | null | undefined) {
  const [expStr, mac, extra] = (sig ?? '').split('.');
  if (!expStr || !mac || extra !== undefined || !/^\d+$/.test(expStr)) return false;
  const exp = Number(expStr);
  if (exp < Date.now()) return false;
  return safeEqual(mac, await hmacHex(payload(raw, exp)));
}

// ---------- authorization codes ----------

/** Stores a single-use code (hash only, 60 s) for an approved request and returns the plaintext once. */
export async function createAuthorizationCode(req: ValidAuthorize, scopes: Scope[]) {
  const code = newSecret('code');
  await getDb().insert(schema.oauthCodes).values({
    codeHash: await hashSecret(code),
    clientId: req.clientId,
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    scopes: scopeString(scopes).split(' '),
    resource: req.resource,
    expiresAt: new Date(Date.now() + TTL.code * 1000),
  });
  return code;
}

/** Human-readable source of a client for the consent screen. */
export const clientSource = (c: OAuthClient) => (c.source === 'cimd' ? `metadata document at ${c.clientId}` : 'registered via dynamic client registration');
