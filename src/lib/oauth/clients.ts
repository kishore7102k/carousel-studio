// OAuth clients: registered via DCR (source 'dcr') or described by a Client ID Metadata Document URL (source 'cimd').
import { and, count, eq, gte, lt, sql } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { SCOPES, hashSecret, newSecret, redirectUriProblem } from './core';

export type OAuthClient = typeof schema.oauthClients.$inferSelect;
export type TokenAuthMethod = OAuthClient['tokenAuthMethod'];

export const TOKEN_AUTH_METHODS: readonly TokenAuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];
export const MAX_REDIRECT_URIS = 10;
export const MAX_NAME_BYTES = 2048;
const MAX_URI_LENGTH = 2048;
const DEFAULT_NAME = 'MCP client';

/**
 * The client for a `client_id`: a registered (DCR) client, or — when client_id is an https URL — its
 * metadata document (fetched SSRF-safely and cached 24 h). null when unknown or the document is invalid.
 * Phase 2 item 5 adds the CIMD branch; today this only finds registered clients.
 */
export async function resolveClient(clientId: string): Promise<OAuthClient | null> {
  const [c] = await getDb().select().from(schema.oauthClients).where(eq(schema.oauthClients.clientId, clientId));
  return c ?? null;
}

// ---------- shared metadata validation (DCR body and CIMD documents) ----------

type Problem = { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };

export function checkRedirectUris(value: unknown): { ok: true; uris: string[] } | Problem {
  if (!Array.isArray(value) || value.length === 0)
    return { ok: false, error: 'invalid_redirect_uri', description: 'redirect_uris must be a non-empty array' };
  if (value.length > MAX_REDIRECT_URIS)
    return { ok: false, error: 'invalid_redirect_uri', description: `At most ${MAX_REDIRECT_URIS} redirect_uris` };
  for (const u of value) {
    if (typeof u !== 'string' || u.length > MAX_URI_LENGTH)
      return { ok: false, error: 'invalid_redirect_uri', description: 'redirect_uris must be strings (max 2048 chars)' };
    const problem = redirectUriProblem(u);
    if (problem) return { ok: false, error: 'invalid_redirect_uri', description: problem };
  }
  return { ok: true, uris: [...new Set(value as string[])] };
}

/** Optional client_name: string ≤ 2 KB (UTF-8); empty/missing → fallback. */
export function checkName(value: unknown, fallback: string): { ok: true; name: string } | Problem {
  if (value === undefined || value === null) return { ok: true, name: fallback };
  if (typeof value !== 'string') return { ok: false, error: 'invalid_client_metadata', description: 'client_name must be a string' };
  if (Buffer.byteLength(value, 'utf8') > MAX_NAME_BYTES)
    return { ok: false, error: 'invalid_client_metadata', description: 'client_name is longer than 2 KB' };
  const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return { ok: true, name: name || fallback };
}

/** Optional logo_uri / client_uri: https URL ≤ 2048 chars. */
export function checkHttpsUri(field: string, value: unknown): { ok: true; uri: string | null } | Problem {
  if (value === undefined || value === null || value === '') return { ok: true, uri: null };
  const bad: Problem = { ok: false, error: 'invalid_client_metadata', description: `${field} must be an https URL` };
  if (typeof value !== 'string' || value.length > MAX_URI_LENGTH) return bad;
  try { return new URL(value).protocol === 'https:' ? { ok: true, uri: value } : bad; } catch { return bad; }
}

// ---------- Dynamic Client Registration (RFC 7591) ----------

export type RegistrationMetadata = {
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenAuthMethod: TokenAuthMethod;
  scope: string | null;
  logoUri: string | null;
  clientUri: string | null;
};

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');

export function validateRegistration(body: unknown): { ok: true; metadata: RegistrationMetadata } | Problem {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, error: 'invalid_client_metadata', description: 'Body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const meta = (description: string): Problem => ({ ok: false, error: 'invalid_client_metadata', description });

  const uris = checkRedirectUris(b.redirect_uris);
  if (!uris.ok) return uris;
  const name = checkName(b.client_name, DEFAULT_NAME);
  if (!name.ok) return name;

  const method = b.token_endpoint_auth_method ?? 'none';
  if (typeof method !== 'string' || !(TOKEN_AUTH_METHODS as readonly string[]).includes(method))
    return meta(`token_endpoint_auth_method must be one of ${TOKEN_AUTH_METHODS.join(', ')}`);

  const grantTypes = b.grant_types ?? ['authorization_code'];
  if (!isStringArray(grantTypes) || !grantTypes.includes('authorization_code') ||
      grantTypes.some(g => g !== 'authorization_code' && g !== 'refresh_token'))
    return meta('grant_types must include authorization_code and may add refresh_token');

  const responseTypes = b.response_types ?? ['code'];
  if (!isStringArray(responseTypes) || responseTypes.length === 0 || responseTypes.some(r => r !== 'code'))
    return meta('response_types must be ["code"]');

  let scope: string | null = null;
  if (b.scope !== undefined && b.scope !== null) {
    if (typeof b.scope !== 'string') return meta('scope must be a space-separated string');
    const parts = b.scope.split(/\s+/).filter(Boolean);
    if (parts.some(p => !(SCOPES as readonly string[]).includes(p))) return meta(`scope must be a subset of: ${SCOPES.join(' ')}`);
    scope = SCOPES.filter(s => parts.includes(s)).join(' ') || null;
  }

  const logo = checkHttpsUri('logo_uri', b.logo_uri);
  if (!logo.ok) return logo;
  const site = checkHttpsUri('client_uri', b.client_uri);
  if (!site.ok) return site;

  return {
    ok: true,
    metadata: {
      clientName: name.name,
      redirectUris: uris.uris,
      grantTypes: [...new Set(grantTypes)],
      responseTypes: [...new Set(responseTypes)],
      tokenAuthMethod: method as TokenAuthMethod,
      scope,
      logoUri: logo.uri,
      clientUri: site.uri,
    },
  };
}

/** How many clients this IP registered since `since` (rate limit). */
export async function registrationsSince(ip: string, since: Date) {
  const c = schema.oauthClients;
  const [row] = await getDb().select({ n: count() }).from(c)
    .where(and(eq(c.source, 'dcr'), eq(c.registeredIp, ip), gte(c.createdAt, since)));
  return row?.n ?? 0;
}

/** Lazy cleanup: DCR clients older than 30 days that never received a token. */
export async function cleanupUnusedClients() {
  const c = schema.oauthClients;
  const t = schema.oauthTokens;
  await getDb().delete(c).where(and(
    eq(c.source, 'dcr'),
    lt(c.createdAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
    sql`not exists (select 1 from ${t} where ${t.clientId} = ${c.clientId})`,
  ));
}

/** Stores a new DCR client. The secret (only for confidential methods) is returned once and stored hashed. */
export async function registerClient(m: RegistrationMetadata, ip: string) {
  const clientId = 'scl_' + Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url');
  const clientSecret = m.tokenAuthMethod === 'none' ? null : newSecret('client_secret');
  const [row] = await getDb().insert(schema.oauthClients).values({
    clientId,
    secretHash: clientSecret ? await hashSecret(clientSecret) : null,
    name: m.clientName,
    redirectUris: m.redirectUris,
    tokenAuthMethod: m.tokenAuthMethod,
    logoUri: m.logoUri,
    clientUri: m.clientUri,
    source: 'dcr',
    registeredIp: ip,
  }).returning({ createdAt: schema.oauthClients.createdAt });
  return { clientId, clientSecret, issuedAt: row.createdAt };
}
