// Authorization codes, access/refresh tokens, rotation and revocation (Phase 2 items 7-8).
// /oauth/token and /oauth/revoke are thin wrappers around tokenEndpoint() / revokeEndpoint().
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { resolveClient, type OAuthClient } from './clients';
import {
  TTL, checkResource, hashSecret, isSubset, mcpResource, newSecret, oauthError, oauthJson, parseScopes, readParams, verifyPkce,
  safeEqual, scopeString, type Scope,
} from './core';

const T = schema.oauthTokens;
const C = schema.oauthCodes;

// ---------- errors ----------

/** An RFC 6749 §5.2 error, thrown inside the endpoint and turned into a response at the top. */
class OAuthFailure extends Error {
  constructor(readonly error: string, readonly description: string, readonly status = 400, readonly headers: Record<string, string> = {}) {
    super(description);
  }
}
const fail = (error: string, description: string): never => { throw new OAuthFailure(error, description); };
const invalidClient = (description: string): never => {
  throw new OAuthFailure('invalid_client', description, 401, { 'WWW-Authenticate': 'Basic realm="carousel-studio", charset="UTF-8"' });
};

async function handle(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof OAuthFailure) return oauthError(e.error, e.description, e.status, e.headers);
    console.error('oauth endpoint error', e instanceof Error ? e.message : e); // never log params: they hold secrets
    return oauthError('server_error', 'Unexpected error', 500);
  }
}

/** Params must not repeat (RFC 6749 §3.2). */
async function readSingleParams(req: Request) {
  const params = await readParams(req);
  for (const k of new Set(params.keys())) if (params.getAll(k).length > 1) fail('invalid_request', `${k} must not be repeated`);
  const get = (k: string) => { const v = params.get(k); return v === null || v === '' ? null : v; };
  return get;
}

// ---------- client authentication ----------

/** `Authorization: Basic base64(urlencode(id):urlencode(secret))` (RFC 6749 §2.3.1). undefined when absent. */
function basicCredentials(req: Request): { id: string; secret: string } | undefined {
  const h = req.headers.get('authorization');
  if (!h) return undefined;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(h);
  if (!m) return invalidClient('Unsupported Authorization header');
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return invalidClient('Malformed Basic credentials');
  const form = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return invalidClient('Malformed Basic credentials'); } };
  return { id: form(decoded.slice(0, i)), secret: form(decoded.slice(i + 1)) };
}

type Credentials = { id: string | null; basic: { id: string; secret: string } | undefined; postSecret: string | null };

/** What the request presents as client identity. Pure parsing: no DB, no CIMD fetch. */
function presentedCredentials(req: Request, get: (k: string) => string | null): Credentials {
  const basic = basicCredentials(req);
  const postSecret = get('client_secret');
  const paramId = get('client_id');
  if (basic && postSecret) return fail('invalid_request', 'Use one client authentication method');
  if (basic && paramId && paramId !== basic.id) return invalidClient('client_id does not match the credentials');
  return { id: basic?.id ?? paramId, basic, postSecret };
}

/**
 * Authenticates the client a grant was issued to, per its registered token_endpoint_auth_method.
 * Callers look the grant up by hash FIRST and pass its client_id, and only after checking the presented
 * id equals it: these endpoints are public, so an arbitrary client_id must never trigger a CIMD fetch.
 */
async function authenticateClient(creds: Credentials, grantClientId: string): Promise<OAuthClient> {
  const { basic, postSecret } = creds;
  if (creds.id !== grantClientId) return invalidClient('Client mismatch');
  const client = await resolveClient(grantClientId).catch(() => null);
  if (!client) return invalidClient('Unknown client');

  const presented = client.tokenAuthMethod === 'client_secret_basic' ? basic?.secret
    : client.tokenAuthMethod === 'client_secret_post' ? postSecret
    : undefined;
  if (client.tokenAuthMethod === 'none') {
    if (basic || postSecret) return invalidClient('This client is public and must not send a secret');
  } else {
    if (!presented || (client.tokenAuthMethod === 'client_secret_post' && basic) || (client.tokenAuthMethod === 'client_secret_basic' && postSecret))
      return invalidClient(`Client must authenticate with ${client.tokenAuthMethod}`);
    if (!client.secretHash || !safeEqual(await hashSecret(presented), client.secretHash)) return invalidClient('Invalid client credentials');
  }
  await getDb().update(schema.oauthClients).set({ lastUsedAt: new Date() }).where(eq(schema.oauthClients.id, client.id));
  return client;
}

// ---------- token families ----------

/**
 * Revokes every live token of a family. Repeated until a pass finds nothing, so a token inserted by a
 * concurrent rotation/exchange that committed between passes is caught too.
 */
export async function revokeFamily(familyId: string) {
  for (let i = 0; i < 3; i++) {
    const rows = await getDb().update(T).set({ revokedAt: sql`now()` })
      .where(and(eq(T.familyId, familyId), isNull(T.revokedAt))).returning({ id: T.id });
    if (!rows.length) break;
  }
}

function tokenResponse(access: string, refresh: string, scopes: readonly string[]) {
  return oauthJson({ access_token: access, token_type: 'Bearer', expires_in: TTL.access, refresh_token: refresh, scope: scopeString(scopes) });
}

async function newPair() {
  const access = newSecret('access'), refresh = newSecret('refresh');
  const now = Date.now();
  return {
    access, refresh,
    accessHash: await hashSecret(access), refreshHash: await hashSecret(refresh),
    accessExp: new Date(now + TTL.access * 1000), refreshExp: new Date(now + TTL.refresh * 1000),
  };
}

/** Narrowing only: a requested `scope` must be valid and ⊆ the grant; omitted keeps the grant. */
function requestedScopes(param: string | null, granted: readonly string[]): string[] {
  if (param === null) return [...granted];
  const parsed = parseScopes(param);
  if (!parsed || !isSubset(parsed, granted)) return fail('invalid_scope', 'scope must be a subset of the original grant');
  return parsed;
}

// ---------- grants ----------

const EPOCH = new Date(0);

async function authorizationCodeGrant(req: Request, get: (k: string) => string | null) {
  const code = get('code'), redirectUri = get('redirect_uri'), verifier = get('code_verifier');
  if (!code || !redirectUri || !verifier) fail('invalid_request', 'code, redirect_uri and code_verifier are required');
  const resource = checkResource(get('resource'));
  if (!resource) fail('invalid_target', 'resource must be this server\'s MCP endpoint');
  const creds = presentedCredentials(req, get);
  if (!creds.id) invalidClient('Client authentication required');

  const db = getDb();
  const codeHash = await hashSecret(code!);
  // Replay of a used code: mark it (expires_at = epoch, see the re-check below) and revoke what it issued.
  const replay = async (): Promise<never> => {
    const [used] = await db.update(C).set({ expiresAt: EPOCH }).where(eq(C.codeHash, codeHash)).returning({ familyId: C.familyId });
    if (used) await revokeFamily(used.familyId);
    return fail('invalid_grant', 'Authorization code was already used; its tokens are revoked');
  };
  // Look the code up by hash before touching the client: unknown codes never resolve (or CIMD-fetch) a client.
  const [found] = await db.select().from(C).where(eq(C.codeHash, codeHash));
  if (!found) return fail('invalid_grant', 'Invalid authorization code');
  if (found.usedAt) return replay();
  if (creds.id !== found.clientId) return fail('invalid_grant', 'Authorization code was issued to another client');
  const client = await authenticateClient(creds, found.clientId);

  // Single use: whoever flips used_at first owns the code.
  const [row] = await db.update(C).set({ usedAt: sql`now()` }).where(and(eq(C.codeHash, codeHash), isNull(C.usedAt))).returning();
  if (!row) return replay();
  if (row.expiresAt.getTime() <= Date.now()) fail('invalid_grant', 'Authorization code expired');
  if (row.redirectUri !== redirectUri) fail('invalid_grant', 'redirect_uri does not match the authorization request');
  if (!(await verifyPkce(verifier!, row.codeChallenge))) fail('invalid_grant', 'PKCE verification failed');
  if (row.resource !== resource) fail('invalid_target', 'resource does not match the authorization request');

  const p = await newPair();
  const base = { clientId: client.clientId, scopes: row.scopes, resource: row.resource, familyId: row.familyId };
  await db.insert(T).values([
    { ...base, kind: 'access', tokenHash: p.accessHash, expiresAt: p.accessExp },
    { ...base, kind: 'refresh', tokenHash: p.refreshHash, expiresAt: p.refreshExp },
  ]);
  // A replay that raced this exchange marks the code before revoking; if the mark is visible now, our
  // tokens may have been inserted after its revoke pass, so revoke them here.
  const [after] = await db.select({ expiresAt: C.expiresAt }).from(C).where(eq(C.codeHash, codeHash));
  if (!after || after.expiresAt.getTime() === 0) {
    await revokeFamily(row.familyId);
    fail('invalid_grant', 'Authorization code was already used; its tokens are revoked');
  }
  // Housekeeping: codes are useless a day after expiry.
  await db.delete(C).where(lt(C.expiresAt, new Date(Date.now() - 86_400_000))).catch(() => {});
  return tokenResponse(p.access, p.refresh, row.scopes);
}

async function refreshTokenGrant(req: Request, get: (k: string) => string | null) {
  const refresh = get('refresh_token');
  if (!refresh) fail('invalid_request', 'refresh_token is required');
  const resource = checkResource(get('resource'));
  if (!resource) fail('invalid_target', 'resource must be this server\'s MCP endpoint');
  const scopeParam = get('scope');
  if (scopeParam !== null && !parseScopes(scopeParam)) fail('invalid_scope', 'Unknown scope');
  const creds = presentedCredentials(req, get);
  if (!creds.id) invalidClient('Client authentication required');

  const db = getDb();
  const hash = await hashSecret(refresh!);
  // Token first, client second (see authenticateClient).
  const [row] = await db.select().from(T).where(and(eq(T.tokenHash, hash), eq(T.kind, 'refresh')));
  if (!row) return fail('invalid_grant', 'Invalid refresh token');
  if (row.revokedAt) {
    // Rotated (or revoked) token presented again: assume theft, kill the family.
    await revokeFamily(row.familyId);
    return fail('invalid_grant', 'Refresh token was already used; the connection is revoked');
  }
  if (creds.id !== row.clientId) {
    // Another client holds this client's refresh token: it leaked.
    await revokeFamily(row.familyId);
    return fail('invalid_grant', 'Refresh token was issued to another client');
  }
  const client = await authenticateClient(creds, row.clientId);
  if (row.expiresAt.getTime() <= Date.now()) return fail('invalid_grant', 'Refresh token expired');
  if (row.resource !== resource) return fail('invalid_target', 'resource does not match the grant');
  const scopes = requestedScopes(scopeParam, row.scopes);

  // Rotate atomically: revoke the old refresh token and insert the new pair in one statement.
  const p = await newPair();
  const result = await db.execute(sql`
    WITH old AS (
      UPDATE oauth_tokens SET revoked_at = now()
      WHERE token_hash = ${hash} AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > now() AND client_id = ${client.clientId}
      RETURNING family_id, resource
    )
    INSERT INTO oauth_tokens (client_id, kind, token_hash, scopes, resource, family_id, expires_at)
    SELECT ${client.clientId}, v.kind, v.hash, string_to_array(${scopeString(scopes)}, ' '), old.resource, old.family_id, v.exp
    FROM old CROSS JOIN (VALUES
      ('access', ${p.accessHash}, ${p.accessExp.toISOString()}::timestamptz),
      ('refresh', ${p.refreshHash}, ${p.refreshExp.toISOString()}::timestamptz)
    ) AS v(kind, hash, exp)
    RETURNING kind`);
  const inserted = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  if (!Array.isArray(inserted) || inserted.length !== 2) {
    // Lost a race with another use of the same refresh token: that is reuse.
    await revokeFamily(row.familyId);
    return fail('invalid_grant', 'Refresh token was already used; the connection is revoked');
  }
  return tokenResponse(p.access, p.refresh, scopes);
}

// ---------- endpoints ----------

/** POST /oauth/token (RFC 6749 §3.2, OAuth 2.1): authorization_code (+PKCE) and refresh_token grants. */
export function tokenEndpoint(req: Request): Promise<Response> {
  return handle(async () => {
    const get = await readSingleParams(req);
    const grant = get('grant_type');
    if (!grant) return fail('invalid_request', 'grant_type is required');
    if (grant === 'authorization_code') return authorizationCodeGrant(req, get);
    if (grant === 'refresh_token') return refreshTokenGrant(req, get);
    return fail('unsupported_grant_type', 'Supported: authorization_code, refresh_token');
  });
}

/**
 * POST /oauth/revoke (RFC 7009). 200 whether or not the token was valid. Access token → revoked;
 * refresh token → its whole family. A request that names no client revokes by possession; one that names the
 * owning client must authenticate (401 otherwise); one naming another client is a no-op. The token is looked
 * up first, so unknown tokens never resolve (or CIMD-fetch) a client.
 */
export function revokeEndpoint(req: Request): Promise<Response> {
  return handle(async () => {
    const get = await readSingleParams(req);
    const token = get('token');
    if (!token) return fail('invalid_request', 'token is required');
    const creds = presentedCredentials(req, get);
    const [row] = await getDb().select().from(T).where(eq(T.tokenHash, await hashSecret(token)));
    if (!row || (creds.id && creds.id !== row.clientId)) return oauthJson({});
    if (creds.id) await authenticateClient(creds, row.clientId);
    if (row.kind === 'refresh') await revokeFamily(row.familyId);
    else await getDb().update(T).set({ revokedAt: sql`now()` }).where(and(eq(T.id, row.id), isNull(T.revokedAt)));
    return oauthJson({});
  });
}

// ---------- MCP verification ----------

export type AccessGrant = {
  /** OAuth client_id (DCR id or CIMD URL). */
  clientId: string;
  /** Display name, used as the activity actor. */
  clientName: string;
  scopes: Scope[];
  /** Expiry in seconds since epoch (MCP AuthInfo.expiresAt). */
  expiresAt: number;
};

/**
 * Verifies a `sat_` access token for the MCP endpoint: known hash, kind access, not revoked, not expired,
 * audience = mcpResource(). Returns the grant or null. last_used_at is written at most once a minute.
 */
export async function verifyAccessToken(token: string): Promise<AccessGrant | null> {
  if (!token.startsWith('sat_')) return null;
  const db = getDb();
  const [row] = await db
    .select({ id: T.id, clientId: T.clientId, scopes: T.scopes, expiresAt: T.expiresAt, name: schema.oauthClients.name })
    .from(T)
    .innerJoin(schema.oauthClients, eq(schema.oauthClients.clientId, T.clientId))
    .where(and(
      eq(T.tokenHash, await hashSecret(token)), eq(T.kind, 'access'), isNull(T.revokedAt),
      gt(T.expiresAt, sql`now()`), eq(T.resource, mcpResource()),
    ));
  if (!row) return null;
  const stale = or(isNull(T.lastUsedAt), lt(T.lastUsedAt, sql`now() - interval '1 minute'`));
  const touched = await db.update(T).set({ lastUsedAt: sql`now()` }).where(and(eq(T.id, row.id), stale)).returning({ id: T.id });
  if (touched.length) await db.update(schema.oauthClients).set({ lastUsedAt: new Date() }).where(eq(schema.oauthClients.clientId, row.clientId));
  return {
    clientId: row.clientId,
    clientName: row.name,
    scopes: row.scopes.filter((s): s is Scope => s === 'read' || s === 'write' || s === 'admin'),
    expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
  };
}
