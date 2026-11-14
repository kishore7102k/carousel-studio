// Client ID Metadata Documents (MCP CIMD draft): a client_id that is an https URL points at the client's
// metadata JSON. Fetching a URL chosen by a stranger is an SSRF risk, so the fetcher is deliberately strict:
// https only, every resolved address must be public unicast, 3 s timeout, no redirects, max 8 KB, JSON only.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { issuer } from './core';
import { checkHttpsUri, checkName, checkRedirectUris } from './clients';

export const CIMD_TIMEOUT_MS = 3000;
export const CIMD_MAX_BYTES = 8 * 1024;
export const DEV_TEST_PATH = '/api/dev/cimd-test';

/** A client_id that should be treated as a metadata document URL (the fetcher decides if it is allowed). */
export const isCimdClientId = (clientId: string) => /^https?:\/\//i.test(clientId);

// ---------- address guard ----------

// Separate lists per family: Node's BlockList also matches IPv4 addresses against IPv6 rules (as ::ffff:a.b.c.d),
// so one shared list containing ::ffff:0:0/96 would refuse every IPv4 address.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT (also Alibaba metadata 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (AWS/GCP/Azure metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) blocked4.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 96], // NAT64 (embeds IPv4)
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo (embeds IPv4)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds IPv4)
  ['fc00::', 7], // unique local (incl. AWS IPv6 metadata fd00:ec2::254)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) blocked6.addSubnet(net, bits, 'ipv6');

/** Only global unicast IPv6 (2000::/3) is allowed at all; the list above then removes special ranges. */
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

/** null when the IP literal is a public unicast address we may connect to, else the reason. */
export function addressProblem(ip: string): string | null {
  const family = isIP(ip);
  if (family === 4) return blocked4.check(ip, 'ipv4') ? `non-public address ${ip}` : null;
  if (family === 6) {
    if (blocked6.check(ip, 'ipv6') || !globalV6.check(ip, 'ipv6')) return `non-public address ${ip}`;
    return null;
  }
  return `not an IP address: ${ip}`;
}

/** The one dev-only exception: our own /api/dev/cimd-test route on the dev server (http://localhost). */
function isDevTestUrl(u: URL) {
  if (process.env.NODE_ENV === 'production') return false;
  try { return u.origin === new URL(issuer()).origin && u.pathname === DEV_TEST_PATH; } catch { return false; }
}

/** Validates the URL itself and every address its host resolves to. null = OK. */
export async function urlProblem(raw: string): Promise<string | null> {
  if (raw.length > 2048) return 'client_id URL too long';
  let u: URL;
  try { u = new URL(raw); } catch { return 'client_id is not a URL'; }
  if (u.username || u.password) return 'client_id URL must not contain credentials';
  if (u.hash) return 'client_id URL must not contain a fragment';
  if (isDevTestUrl(u)) return null;
  if (u.protocol !== 'https:') return 'client_id URL must be https';
  if (u.pathname === '/' || u.pathname === '') return 'client_id URL must have a path';

  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string }[];
  try {
    addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  } catch {
    return `cannot resolve ${host}`;
  }
  if (!addresses.length) return `cannot resolve ${host}`;
  for (const { address } of addresses) {
    const p = addressProblem(address);
    if (p) return `${host} resolves to a ${p}`;
  }
  // Known gap (acceptable for this phase): DNS rebinding. fetch() resolves the name again, so a hostile DNS
  // server could answer with a public IP for the lookup above and a private one for the connection.
  // Closing it needs a custom dispatcher that connects to the vetted address (undici `connect.lookup`).
  return null;
}

// ---------- fetch + validate ----------

export type CimdMetadata = {
  clientId: string;
  name: string;
  redirectUris: string[];
  logoUri: string | null;
  clientUri: string | null;
};

export type CimdResult = { ok: true; metadata: CimdMetadata } | { ok: false; reason: string };

async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > max) return null;
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Fetches and validates a client metadata document. Never throws. */
export async function fetchClientMetadata(clientId: string): Promise<CimdResult> {
  const fail = (reason: string): CimdResult => ({ ok: false, reason });
  const problem = await urlProblem(clientId);
  if (problem) return fail(problem);

  let res: Response;
  try {
    res = await fetch(clientId, {
      redirect: 'manual',
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
  } catch (e) {
    return fail(`fetch failed: ${(e as Error).name}`);
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return fail(res.status >= 300 && res.status < 400 ? 'redirects are not followed' : `HTTP ${res.status}`);
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && !/^application\/[\w.+-]+\+json$/.test(type)) {
    await res.body?.cancel().catch(() => {});
    return fail(`content-type must be JSON, got ${type || 'none'}`);
  }

  let text: string | null;
  try { text = await readCapped(res, CIMD_MAX_BYTES); } catch { return fail('read failed'); }
  if (text === null) return fail(`document larger than ${CIMD_MAX_BYTES} bytes`);
  let doc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('document is not a JSON object');
    doc = parsed;
  } catch { return fail('document is not valid JSON'); }

  if (doc.client_id !== clientId) return fail('document client_id does not equal its URL');
  const uris = checkRedirectUris(doc.redirect_uris);
  if (!uris.ok) return fail(uris.description);
  const name = checkName(doc.client_name, new URL(clientId).host);
  if (!name.ok) return fail(name.description);
  const method = doc.token_endpoint_auth_method ?? 'none';
  if (method !== 'none') return fail('token_endpoint_auth_method must be none (metadata-document clients are public)');
  const logo = checkHttpsUri('logo_uri', doc.logo_uri);
  if (!logo.ok) return fail(logo.description);
  const site = checkHttpsUri('client_uri', doc.client_uri);
  if (!site.ok) return fail(site.description);

  return { ok: true, metadata: { clientId, name: name.name, redirectUris: uris.uris, logoUri: logo.uri, clientUri: site.uri } };
}
