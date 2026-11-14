// OAuth 2.1 building blocks shared by every /oauth route, the consent page and the MCP verifier.
// No dependencies beyond Web Crypto. All secrets are opaque random strings stored as sha256 hashes.
import { sha256 } from '@/lib/auth';
import { studioUrl } from '@/lib/url';

// ---------- identifiers ----------

export const SCOPES = ['read', 'write', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

/** Lifetimes in seconds. */
export const TTL = { code: 60, access: 60 * 60, refresh: 60 * 24 * 60 * 60 } as const;

/** Issuer = studio origin, no trailing slash (RFC 8414 / RFC 9207). */
export const issuer = () => studioUrl('');
/** The one protected resource (RFC 8707 audience of every token). */
export const mcpResource = () => studioUrl('/api/mcp');
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/api/mcp';
export const resourceMetadataUrl = () => studioUrl(RESOURCE_METADATA_PATH);

// ---------- secrets ----------

const PREFIX = { access: 'sat_', refresh: 'srt_', code: 'sac_', client_secret: 'scs_' } as const;
export type SecretKind = keyof typeof PREFIX;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/** New opaque secret: `sat_` access, `srt_` refresh, `sac_` code, `scs_` client secret (32 random bytes). */
export function newSecret(kind: SecretKind) {
  return PREFIX[kind] + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The only form in which secrets are stored or compared. */
export const hashSecret = (secret: string) => sha256(secret);

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- PKCE (RFC 7636, S256 only) ----------

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/; // base64url(sha256) without padding

export const isValidChallenge = (c: string | null | undefined): c is string => !!c && CHALLENGE.test(c);

export async function s256(verifier: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export async function verifyPkce(verifier: string | null | undefined, challenge: string) {
  if (!verifier || !VERIFIER.test(verifier)) return false;
  return safeEqual(await s256(verifier), challenge);
}

// ---------- scopes ----------

/**
 * Parses a space-separated `scope` parameter. Missing/empty → read + write (admin only when asked for).
 * Unknown scopes → null (caller answers `invalid_scope`). Result is deduped, in canonical order.
 */
export function parseScopes(param: string | null | undefined): Scope[] | null {
  const parts = (param ?? '').split(/\s+/).filter(Boolean);
  if (!parts.length) return ['read', 'write'];
  if (parts.some(p => !(SCOPES as readonly string[]).includes(p))) return null;
  return SCOPES.filter(s => parts.includes(s));
}

export const scopeString = (scopes: readonly string[]) => SCOPES.filter(s => scopes.includes(s)).join(' ');

/** true when every scope in `requested` is in `granted` (refresh may only narrow). */
export const isSubset = (requested: readonly string[], granted: readonly string[]) => requested.every(s => granted.includes(s));

// ---------- resource indicators (RFC 8707) ----------

const stripSlash = (u: string) => u.replace(/\/+$/, '');

/** Canonical resource for a request: missing → this server's resource; wrong → null (`invalid_target`). */
export function checkResource(resource: string | null | undefined): string | null {
  if (!resource) return mcpResource();
  return stripSlash(resource) === stripSlash(mcpResource()) ? mcpResource() : null;
}

// ---------- redirect URIs ----------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLoopbackHost = (hostname: string) => LOOPBACK.has(hostname);

/** null when acceptable: https://, or http:// on a loopback host (any port). No fragments, no credentials. */
export function redirectUriProblem(uri: string): string | null {
  let u: URL;
  try { u = new URL(uri); } catch { return `not a URL: ${uri}`; }
  if (u.hash) return `redirect_uri must not contain a fragment: ${uri}`;
  if (u.username || u.password) return `redirect_uri must not contain credentials: ${uri}`;
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) return null;
  return `redirect_uri must be https (http only for localhost/127.0.0.1/[::1]): ${uri}`;
}

/** Exact match against a registered URI; loopback URIs match ignoring the port (RFC 8252 §7.3). */
export function redirectUriMatches(registered: readonly string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try { g = new URL(given); } catch { return false; }
  if (g.protocol !== 'http:' || !isLoopbackHost(g.hostname)) return false;
  return registered.some(r => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
    } catch { return false; }
  });
}

// ---------- HTTP helpers ----------

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

/** 204 answer to a CORS preflight (metadata, register, token, revoke routes only). */
export const corsPreflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });

/** JSON response with CORS and `Cache-Control: no-store`. */
export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache', ...CORS_HEADERS, ...headers },
  });
}

/** RFC 6749 §5.2 error body. */
export const oauthError = (error: string, description?: string, status = 400, headers: Record<string, string> = {}) =>
  oauthJson({ error, ...(description ? { error_description: description } : {}) }, status, headers);

/** Reads a POST body that may be form-encoded (token/revoke) or JSON. */
export async function readParams(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return new URLSearchParams(Object.entries(body).filter(([, v]) => typeof v === 'string') as [string, string][]);
  }
  return new URLSearchParams(await req.text());
}

/** Best-effort client IP for rate limits. */
export const clientIp = (req: Request) =>
  req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
