/* eslint-disable @typescript-eslint/no-explicit-any -- protocol responses are untyped JSON */
// OAuth 2.1 smoke test (docs/phase-2-oauth.md section 6). Everything over HTTP against the running studio.
//   npm run oauth:smoke            (STUDIO_URL, default http://localhost:3000; needs STUDIO_PASSWORD)
// Drives the real login + consent page with playwright-core and receives the redirect on a loopback server.
// Creates clients/codes/tokens (and a temporary admin API key) and deletes all of them in `finally`.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { eq, inArray, like } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { newApiKey, sha256 } from '@/lib/auth';
import { hashSecret } from '@/lib/oauth/core';

const BASE = process.env.STUDIO_URL?.replace(/\/+$/, '') || 'http://localhost:3000';
const ENDPOINT = `${BASE}/api/mcp`;
const RUN = Math.random().toString(36).slice(2, 8);
const PASSWORD = process.env.STUDIO_PASSWORD ?? '';

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];
const check = (name: string, ok: boolean, detail = '') => { rows.push({ name, ok, detail: ok ? '' : detail }); };

// ---------- helpers ----------

const b64url = (b: Buffer) => b.toString('base64url');
const pkce = () => {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
};
const mask = (v: unknown) => JSON.stringify(v).replace(/(sat_|srt_|sac_)[\w-]+/g, '$1...');

async function mcp(token: string, tool: string, args: Record<string, unknown> = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const txt = await res.text();
  const data = txt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
  let rpc: any = null;
  try { rpc = JSON.parse(data.length ? data[data.length - 1] : txt); } catch { /* not JSON (401 body) */ }
  const content: any[] = rpc?.result?.content ?? [];
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n') || rpc?.error?.message || txt.slice(0, 200);
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  const ok = res.status === 200 && !!rpc?.result && !rpc.result.isError;
  return { status: res.status, ok, text, data: parsed, www: res.headers.get('www-authenticate') ?? '' };
}

async function tokenReq(params: Record<string, string>) {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body, cache: res.headers.get('cache-control') ?? '' };
}

// ---------- loopback redirect receiver ----------

let waiter: ((p: URLSearchParams) => void) | null = null;
let stray = 0;
const loop = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1');
  res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  if (u.pathname !== '/callback') return;
  if (waiter) { const w = waiter; waiter = null; w(u.searchParams); } else stray++;
});
const nextCallback = (ms: number) => new Promise<URLSearchParams | null>(resolve => {
  const mine = (p: URLSearchParams) => { clearTimeout(t); resolve(p); };
  const t = setTimeout(() => { if (waiter === mine) waiter = null; resolve(null); }, ms);
  waiter = mine; // a newer waiter supersedes an older one; the old one just times out
});
let REDIRECT = '';

// ---------- browser ----------

const ALLOW = 'button[name="decision"][value="allow"]';
const DENY = 'button[name="decision"][value="deny"]';
let browser: Browser | null = null;
let ctx: BrowserContext | null = null;

async function launch(): Promise<Browser> {
  return process.env.CHROME_PATH
    ? chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
    : chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
}

type AuthOpts = {
  clientId: string; redirectUri?: string; challenge: string; method?: string; scope?: string; resource?: string | null;
  state?: string; untick?: string[]; deny?: boolean;
  /** 'consent' (default): wait for the consent page. 'quick': an error page or error redirect is expected. */
  expect?: 'consent' | 'quick';
};
type AuthResult = { kind: 'callback'; params: URLSearchParams } | { kind: 'page'; url: string; text: string } | { kind: 'timeout'; url: string };

/** Opens /oauth/authorize in the logged-in browser; clicks Allow (or Deny); returns what came back. */
async function authorize(o: AuthOpts): Promise<AuthResult> {
  const quick = o.expect === 'quick';
  const page = await ctx!.newPage();
  try {
    const q = new URLSearchParams({
      response_type: 'code', client_id: o.clientId, redirect_uri: o.redirectUri ?? REDIRECT,
      code_challenge: o.challenge, code_challenge_method: o.method ?? 'S256', state: o.state ?? 'st-' + RUN,
    });
    if (o.scope !== undefined) q.set('scope', o.scope);
    if (o.resource !== null) q.set('resource', o.resource ?? ENDPOINT);
    const cb = nextCallback(quick ? 5000 : 20000);
    await page.goto(`${BASE}/oauth/authorize?${q}`).catch(() => { /* navigation may be superseded by a redirect */ });
    if (page.url().includes('/login')) {
      await page.fill('#password', PASSWORD);
      await page.press('#password', 'Enter');
      await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => { /* */ });
    }
    const first = await Promise.race([
      cb.then(p => ({ t: 'cb' as const, p })),
      page.waitForSelector(ALLOW, { timeout: quick ? 3000 : 15000 }).then(() => ({ t: 'consent' as const })).catch(() => ({ t: 'none' as const })),
    ]);
    if (first.t === 'cb' && first.p) return { kind: 'callback', params: first.p };
    if (first.t === 'consent') {
      for (const s of o.untick ?? []) await page.uncheck(`input[name="scope"][value="${s}"]`);
      const done = nextCallback(15000);
      await page.click(o.deny ? DENY : ALLOW);
      const p = await done;
      return p ? { kind: 'callback', params: p } : { kind: 'timeout', url: page.url() };
    }
    const late = await cb;
    if (late) return { kind: 'callback', params: late };
    return { kind: 'page', url: page.url(), text: (await page.innerText('body').catch(() => '')).slice(0, 300) };
  } finally {
    await page.close().catch(() => { /* */ });
  }
}

// ---------- state for cleanup ----------

const clientIds = new Set<string>();
const keyNames: string[] = [];

async function register(label: string) {
  const name = `oauth-smoke-${RUN}-${label}`;
  const res = await fetch(`${BASE}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'read write admin' }),
  });
  const body: any = await res.json().catch(() => null);
  if (body?.client_id) clientIds.add(body.client_id);
  return { name, status: res.status, body, clientId: body?.client_id as string };
}

/** DCR + authorize (real consent UI) + code exchange. */
async function connect(label: string, scope: string, untick: string[] = []) {
  const reg = await register(label);
  if (!reg.clientId) throw new Error(`DCR failed for ${label}: ${reg.status} ${JSON.stringify(reg.body)}`);
  const { verifier, challenge } = pkce();
  const a = await authorize({ clientId: reg.clientId, challenge, scope, untick });
  if (a.kind !== 'callback' || !a.params.get('code')) throw new Error(`authorize failed for ${label}: ${JSON.stringify(show(a))}`);
  const tok = await tokenReq({ grant_type: 'authorization_code', code: a.params.get('code')!, redirect_uri: REDIRECT, code_verifier: verifier, client_id: reg.clientId, resource: ENDPOINT });
  return { reg, tok, params: a.params };
}

/** A fresh authorization code for an existing client (no exchange yet). */
async function freshCode(clientId: string) {
  const { verifier, challenge } = pkce();
  const a = await authorize({ clientId, challenge, scope: 'read write' });
  const code = a.kind === 'callback' ? a.params.get('code') : null;
  if (!code) throw new Error(`no code: ${JSON.stringify(show(a))}`);
  return { code, verifier };
}

const show = (r: AuthResult) => (r.kind === 'callback' ? Object.fromEntries(r.params) : r);
const REFRESH_ARGS = (clientId: string, refresh: string) => ({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, resource: ENDPOINT });

async function main() {
  const db = getDb();
  if (!PASSWORD) { console.error('STUDIO_PASSWORD is not set'); process.exit(1); }
  await new Promise<void>(r => loop.listen(0, '127.0.0.1', r));
  REDIRECT = `http://127.0.0.1:${(loop.address() as AddressInfo).port}/callback`;

  try {
    // ================= 1. discovery =================
    const as = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    const asj: any = await as.json().catch(() => ({}));
    check('discovery: authorization-server metadata', as.status === 200 && asj.issuer === BASE
      && asj.authorization_endpoint === `${BASE}/oauth/authorize` && asj.token_endpoint === `${BASE}/oauth/token`
      && asj.registration_endpoint === `${BASE}/oauth/register` && asj.revocation_endpoint === `${BASE}/oauth/revoke`
      && JSON.stringify(asj.code_challenge_methods_supported) === '["S256"]' && asj.response_types_supported?.includes('code')
      && asj.grant_types_supported?.includes('refresh_token') && asj.client_id_metadata_document_supported === true
      && asj.authorization_response_iss_parameter_supported === true && asj.scopes_supported?.includes('admin')
      && asj.token_endpoint_auth_methods_supported?.includes('none'), JSON.stringify(asj).slice(0, 300));
    check('discovery: CORS on metadata', as.headers.get('access-control-allow-origin') === '*', String(as.headers.get('access-control-allow-origin')));
    const oi: any = await (await fetch(`${BASE}/.well-known/openid-configuration`)).json().catch(() => ({}));
    check('discovery: openid-configuration mirrors it', oi.issuer === asj.issuer && oi.token_endpoint === asj.token_endpoint, JSON.stringify(oi).slice(0, 200));
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp']) {
      const r = await fetch(`${BASE}${p}`);
      const j: any = await r.json().catch(() => ({}));
      check(`discovery: protected-resource ${p}`, r.status === 200 && j.resource === ENDPOINT && j.authorization_servers?.includes(BASE)
        && j.scopes_supported?.includes('read') && j.bearer_methods_supported?.includes('header'), JSON.stringify(j).slice(0, 250));
    }
    const noAuth = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    const www = noAuth.headers.get('www-authenticate') ?? '';
    check('mcp without auth: 401 + resource_metadata challenge', noAuth.status === 401 && /Bearer/.test(www) && www.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/mcp"`), `${noAuth.status} ${www}`);
    const dcrBad = await fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://evil.example/cb'] }) });
    check('DCR rejects non-https, non-loopback redirect_uri', dcrBad.status === 400, String(dcrBad.status));

    browser = await launch();
    ctx = await browser.newContext();

    // ================= 2. happy path: DCR -> authorize -> consent -> token -> MCP =================
    const m = await connect('main', 'read write admin', ['admin']);
    const reg = m.reg;
    check('DCR returns a public client_id', (reg.status === 201 || reg.status === 200) && !!reg.clientId && !reg.body.client_secret, JSON.stringify(reg.body).slice(0, 200));
    check('authorize redirect carries code, state, iss', !!m.params.get('code') && m.params.get('state') === 'st-' + RUN && m.params.get('iss') === BASE, JSON.stringify(Object.fromEntries(m.params)));
    const t1 = m.tok.body;
    check('token: bearer, sat_ + srt_, scope narrowed by consent, no-store', m.tok.status === 200 && String(t1?.token_type).toLowerCase() === 'bearer' && /^sat_/.test(t1?.access_token) && /^srt_/.test(t1?.refresh_token)
      && typeof t1.expires_in === 'number' && t1.scope === 'read write' && /no-store/.test(m.tok.cache), mask(m.tok).slice(0, 300));
    const lc = await mcp(t1?.access_token ?? '', 'list_carousels', { limit: 1 });
    check('MCP list_carousels with access token', lc.ok, `${lc.status} ${lc.text.slice(0, 150)}`);
    const adm = await mcp(t1?.access_token ?? '', 'list_connections');
    check('unticked admin scope: admin tool -> missing scope', !adm.ok && /missing scope|insufficient/i.test(adm.text + adm.www), `${adm.status} ${adm.text.slice(0, 150)}`);

    // ================= 3. negatives =================
    {
      const c = await freshCode(reg.clientId);
      const bad = await tokenReq({ grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, code_verifier: pkce().verifier, client_id: reg.clientId, resource: ENDPOINT });
      check('neg: wrong code_verifier -> invalid_grant', bad.status === 400 && bad.body?.error === 'invalid_grant', mask(bad));
    }
    {
      const c = await freshCode(reg.clientId);
      const bad = await tokenReq({ grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT + 'x', code_verifier: c.verifier, client_id: reg.clientId, resource: ENDPOINT });
      check('neg: wrong redirect_uri at token -> invalid_grant', bad.status === 400 && bad.body?.error === 'invalid_grant', mask(bad));
    }
    {
      const c = await freshCode(reg.clientId);
      const bad = await tokenReq({ grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, code_verifier: c.verifier, client_id: reg.clientId, resource: ENDPOINT + '/other' });
      check('neg: wrong resource at token -> invalid_target', bad.status === 400 && bad.body?.error === 'invalid_target', mask(bad));
    }
    {
      const c = await freshCode(reg.clientId);
      const args = { grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, code_verifier: c.verifier, client_id: reg.clientId, resource: ENDPOINT };
      const first = await tokenReq(args);
      const firstOk = await mcp(first.body?.access_token ?? '', 'list_carousels', { limit: 1 });
      const second = await tokenReq(args);
      check('neg: reused code -> invalid_grant', first.status === 200 && second.status === 400 && second.body?.error === 'invalid_grant', `${first.status} ${second.status} ${mask(second.body)}`);
      const after = await mcp(first.body?.access_token ?? '', 'list_carousels', { limit: 1 });
      check('neg: reused code revokes the first token (MCP 401)', firstOk.ok && after.status === 401, `before ${firstOk.status}, after ${after.status}`);
    }
    {
      const bogus = await authorize({ clientId: reg.clientId, challenge: pkce().challenge, redirectUri: REDIRECT.replace('/callback', '/elsewhere'), expect: 'quick' });
      check('neg: unregistered redirect_uri -> error page, no redirect', bogus.kind === 'page' && /\/oauth\/authorize/.test(bogus.url), JSON.stringify(show(bogus)));
      const plain = await authorize({ clientId: reg.clientId, challenge: pkce().verifier, method: 'plain', expect: 'quick' });
      check('neg: plain PKCE -> redirect error=invalid_request + iss', plain.kind === 'callback' && plain.params.get('error') === 'invalid_request' && plain.params.get('iss') === BASE && !plain.params.get('code'), JSON.stringify(show(plain)));
      const noCh = await authorize({ clientId: reg.clientId, challenge: '', expect: 'quick' });
      check('neg: missing code_challenge -> error, no code', noCh.kind === 'callback' ? !!noCh.params.get('error') && !noCh.params.get('code') : noCh.kind === 'page', JSON.stringify(show(noCh)));
      const badRes = await authorize({ clientId: reg.clientId, challenge: pkce().challenge, resource: `${BASE}/not-the-mcp`, expect: 'quick' });
      check('neg: wrong resource at authorize -> invalid_target', badRes.kind === 'callback' && badRes.params.get('error') === 'invalid_target' && !badRes.params.get('code'), JSON.stringify(show(badRes)));
      const badScope = await authorize({ clientId: reg.clientId, challenge: pkce().challenge, scope: 'read bogus', expect: 'quick' });
      check('neg: unknown scope -> invalid_scope', badScope.kind === 'callback' && badScope.params.get('error') === 'invalid_scope', JSON.stringify(show(badScope)));
      const denied = await authorize({ clientId: reg.clientId, challenge: pkce().challenge, deny: true });
      check('consent Deny -> access_denied + state + iss', denied.kind === 'callback' && denied.params.get('error') === 'access_denied' && denied.params.get('state') === 'st-' + RUN && denied.params.get('iss') === BASE, JSON.stringify(show(denied)));
    }
    {
      const c = await connect('expire', 'read write');
      const at = c.tok.body?.access_token ?? '';
      const live = await mcp(at, 'list_carousels', { limit: 1 });
      await db.update(schema.oauthTokens).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.oauthTokens.tokenHash, await hashSecret(at)));
      const dead = await mcp(at, 'list_carousels', { limit: 1 });
      check('neg: expired access token -> 401', live.ok && dead.status === 401, `live ${live.status}, expired ${dead.status}`);
    }
    {
      const c = await connect('refresh', 'read write');
      const r1 = c.tok.body?.refresh_token ?? '';
      const rot = await tokenReq(REFRESH_ARGS(c.reg.clientId, r1));
      check('refresh: rotates (new access + refresh)', rot.status === 200 && /^sat_/.test(rot.body?.access_token) && /^srt_/.test(rot.body?.refresh_token) && rot.body.refresh_token !== r1, mask(rot).slice(0, 200));
      const ok2 = await mcp(rot.body?.access_token ?? '', 'list_carousels', { limit: 1 });
      const reuse = await tokenReq(REFRESH_ARGS(c.reg.clientId, r1));
      check('neg: reusing a rotated refresh token -> invalid_grant', reuse.status === 400 && reuse.body?.error === 'invalid_grant', mask(reuse).slice(0, 200));
      const kids = await tokenReq(REFRESH_ARGS(c.reg.clientId, rot.body?.refresh_token ?? ''));
      const dead = await mcp(rot.body?.access_token ?? '', 'list_carousels', { limit: 1 });
      check('neg: refresh reuse revokes the whole family', ok2.ok && kids.status === 400 && dead.status === 401, `new access ${ok2.status}; newest refresh ${kids.status}; newest access after ${dead.status}`);
    }
    {
      const c = await connect('readonly', 'read');
      const at = c.tok.body?.access_token ?? '';
      const rd = await mcp(at, 'list_carousels', { limit: 1 });
      const wt = await mcp(at, 'create_carousel', { title: `oauth-smoke ${RUN}`, slides: [{ kind: 'cover', hook: 'Smoke *test*' }, { kind: 'cta', hook: 'Save *this*.' }], render: false });
      check('read-only token: read ok, write tool -> missing scope', rd.ok && !wt.ok && /missing scope/i.test(wt.text + wt.www), `read ${rd.status}; write ${wt.status} ${wt.text.slice(0, 150)}`);
    }
    {
      const c = await connect('revoke', 'read write');
      const at = c.tok.body?.access_token ?? '';
      const form = { 'content-type': 'application/x-www-form-urlencoded' };
      const rv = await fetch(`${BASE}/oauth/revoke`, { method: 'POST', headers: form, body: new URLSearchParams({ token: c.tok.body?.refresh_token ?? '', token_type_hint: 'refresh_token', client_id: c.reg.clientId }) });
      const after = await mcp(at, 'list_carousels', { limit: 1 });
      const rf = await tokenReq(REFRESH_ARGS(c.reg.clientId, c.tok.body?.refresh_token ?? ''));
      const junk = await fetch(`${BASE}/oauth/revoke`, { method: 'POST', headers: form, body: new URLSearchParams({ token: 'srt_nonsense' }) });
      check('/oauth/revoke: always 200, revoking refresh kills family', rv.status === 200 && junk.status === 200 && after.status === 401 && rf.status === 400, `revoke ${rv.status}, junk ${junk.status}, access ${after.status}, refresh ${rf.status}`);
    }

    // ================= access tools with OAuth apps =================
    {
      const key = newApiKey();
      const kname = `oauth-smoke-${RUN}-adminkey`;
      const [kr] = await db.insert(schema.apiKeys).values({ name: kname, hash: await sha256(key), scopes: ['read', 'write', 'admin'] }).returning({ id: schema.apiKeys.id });
      keyNames.push(kname);
      const c = await connect('tools', 'read write');
      const lcn = await mcp(key, 'list_connections');
      const app = lcn.data?.oauthApps?.find((a: any) => a.name === c.reg.name);
      check('list_connections: oauthApps lists the connected app', lcn.ok && !!app && !app.current && !!lcn.data.apiKeys?.find((k: any) => k.id === kr.id)?.current && !/hash|sat_|srt_/i.test(lcn.text), lcn.text.slice(0, 300));
      if (app) {
        const rvk = await mcp(key, 'revoke_access', { id: app.id });
        const dead = await mcp(c.tok.body?.access_token ?? '', 'list_carousels', { limit: 1 });
        const [still] = await db.select({ id: schema.oauthClients.id }).from(schema.oauthClients).where(eq(schema.oauthClients.clientId, c.reg.clientId));
        const gone = await mcp(key, 'list_connections');
        check('revoke_access(app id): disconnects, MCP 401, client row kept', rvk.ok && dead.status === 401 && !!still && !gone.data?.oauthApps?.some((a: any) => a.id === app.id), `${rvk.text.slice(0, 120)}; mcp ${dead.status}; row ${!!still}`);
      } else check('revoke_access(app id): disconnects, MCP 401, client row kept', false, 'app not listed');

      const adminApp = await connect('selfadmin', 'read write admin');
      const tk = adminApp.tok.body?.access_token ?? '';
      const mine = await mcp(tk, 'list_connections');
      const me = mine.data?.oauthApps?.find((a: any) => a.name === adminApp.reg.name);
      check('OAuth admin token: list_connections flags itself current', mine.ok && me?.current === true, mine.text.slice(0, 250));
      if (me) {
        const self = await mcp(tk, 'revoke_access', { id: me.id });
        const still = await mcp(tk, 'list_carousels', { limit: 1 });
        check('OAuth admin token: revoke_access refuses own app', !self.ok && still.ok, `${self.text.slice(0, 150)}; still ${still.status}`);
      } else check('OAuth admin token: revoke_access refuses own app', false, 'own app not listed');
      const ck = await mcp(tk, 'create_key', { name: `oauth-smoke-${RUN}-made`, scopes: ['read'] });
      check('OAuth admin token can create_key (API keys only)', ck.ok && /^ks_/.test(ck.data?.key ?? ''), ck.text.slice(0, 150));
    }

    // ================= 4. CIMD + SSRF =================
    {
      const cimdId = `${BASE}/api/dev/cimd-test?redirect=${encodeURIComponent(REDIRECT)}`;
      clientIds.add(cimdId);
      const { verifier, challenge } = pkce();
      const a = await authorize({ clientId: cimdId, challenge, scope: 'read write' });
      const code = a.kind === 'callback' ? a.params.get('code') : null;
      check('CIMD: authorize with metadata-URL client_id issues a code', !!code, JSON.stringify(show(a)));
      if (code) {
        const tok = await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: cimdId, resource: ENDPOINT });
        const r = await mcp(tok.body?.access_token ?? '', 'list_carousels', { limit: 1 });
        check('CIMD: token exchange + MCP call', tok.status === 200 && r.ok, `${tok.status} ${mask(tok.body).slice(0, 120)}; mcp ${r.status}`);
      } else check('CIMD: token exchange + MCP call', false, 'no code');
    }
    for (const bad of ['https://127.0.0.1/x', 'http://example.com/x']) {
      const a = await authorize({ clientId: bad, challenge: pkce().challenge, expect: 'quick' });
      check(`SSRF: client_id ${bad} rejected at authorize (no consent, no redirect)`, a.kind === 'page', JSON.stringify(show(a)));
      const t = await tokenReq({ grant_type: 'authorization_code', code: 'sac_nonsense', redirect_uri: REDIRECT, code_verifier: pkce().verifier, client_id: bad, resource: ENDPOINT });
      check(`SSRF: client_id ${bad} rejected at token`, t.status >= 400 && t.status < 500 && !t.body?.access_token, mask(t).slice(0, 160));
    }
    check('no stray redirects reached the loopback receiver', stray === 0, `${stray} unexpected callbacks`);
  } catch (err) {
    check('script error', false, err instanceof Error ? (err.stack ?? err.message).split('\n').slice(0, 3).join(' | ') : String(err));
  } finally {
    try { await ctx?.close(); await browser?.close(); } catch { /* */ }
    loop.closeAllConnections?.();
    await new Promise<void>(r => loop.close(() => r()));
    try {
      const sweep = async (ids: string[]) => {
        if (!ids.length) return;
        await db.delete(schema.oauthTokens).where(inArray(schema.oauthTokens.clientId, ids));
        await db.delete(schema.oauthCodes).where(inArray(schema.oauthCodes.clientId, ids));
        await db.delete(schema.oauthClients).where(inArray(schema.oauthClients.clientId, ids));
      };
      await sweep([...clientIds]);
      // clients the server created that never made it into our set (defensive sweep by name)
      const stale = await db.select({ clientId: schema.oauthClients.clientId }).from(schema.oauthClients).where(like(schema.oauthClients.name, `oauth-smoke-${RUN}-%`));
      await sweep(stale.map(x => x.clientId));
      await db.delete(schema.carousels).where(like(schema.carousels.title, `oauth-smoke ${RUN}%`)); // only exists if scope enforcement failed
      await db.delete(schema.activity).where(like(schema.activity.actor, `oauth-smoke-${RUN}-%`));
      if (keyNames.length) await db.delete(schema.activity).where(inArray(schema.activity.actor, keyNames));
      await db.delete(schema.apiKeys).where(like(schema.apiKeys.name, `oauth-smoke-${RUN}-%`));
    } catch (err) { check('cleanup', false, String(err)); }
  }

  const w = Math.max(...rows.map(r => r.name.length));
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}${r.ok ? '' : `  ${r.detail.replace(/\s+/g, ' ').slice(0, 220)}`}`);
  const failed = rows.filter(r => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ''}  (${BASE})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
