/* eslint-disable @typescript-eslint/no-explicit-any -- MCP tool results are untyped JSON */
// End-to-end UI test: drives the real studio UI in a headless browser and checks it against the DB and the MCP server.
//   npm run ui:e2e                       (against STUDIO_URL, default http://localhost:3000)
//   UI_E2E_SHOTS=<dir>                   failure screenshots (default ui-e2e-shots/, gitignored)
// Signs in through /login with STUDIO_PASSWORD. Needs DATABASE_URL (temp admin key, checks, cleanup).
// Only mutates data it creates: every title/name/prompt starts with "zz-e2e-<run>". The owner's carousels, keys and brand
// are opened read-only; the brand form is only submitted with invalid input that is rejected before saving.
// Everything created is purged in `finally`, then verified gone. Exits non-zero on any FAIL.
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { and, eq, gte, inArray, like, lt } from 'drizzle-orm';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { list, del } from '@vercel/blob';
import { getDb, schema } from '@/db';
import { newApiKey, sha256 } from '@/lib/auth';
import { ROLES } from '@/lib/brand';

const BASE = process.env.STUDIO_URL?.replace(/\/+$/, '') || 'http://localhost:3000';
const ENDPOINT = `${BASE}/api/mcp`;
const SHOTS = path.resolve(process.env.UI_E2E_SHOTS || 'ui-e2e-shots');
const PASSWORD = process.env.STUDIO_PASSWORD ?? '';
const RUN = Math.random().toString(36).slice(2, 8);
const TAG = `zz-e2e-${RUN}`;
const RUN_START = new Date(Date.now() - 2 * 60_000); // margin for clock skew with the DB
const RENDER_MS = 240_000; // server actions that render on Vercel (serverless Chromium, cold starts)

// ---------- result table ----------

type Status = 'PASS' | 'FAIL' | 'SKIP';
type Row = { n: number; name: string; status: Status; ms: number; detail: string; shot?: string };
const rows: Row[] = [];
class Skip extends Error {}
const need = <T>(v: T | null | undefined, what: string): T => { if (v == null || v === '') throw new Skip(`needs ${what}`); return v; };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (s: string) => new RegExp(`^\\s*${esc(s)}\\s*$`);

let bucket: string[] | null = null; // errors seen by the browser during the current step
let active: Page | null = null; // page to screenshot on failure

async function step(name: string, fn: () => Promise<string | void>) {
  const n = rows.length + 1;
  const errs: string[] = [];
  bucket = errs;
  const t0 = Date.now();
  let status: Status = 'PASS';
  let detail = '';
  try {
    detail = (await fn()) || '';
    await sleep(300); // let late console/page errors from this step arrive
  } catch (e) {
    if (e instanceof Skip) { status = 'SKIP'; detail = e.message; } else { status = 'FAIL'; detail = msg(e); }
  }
  bucket = null;
  if (errs.length) {
    const extra = `browser errors: ${[...new Set(errs)].slice(0, 4).join(' | ')}`;
    if (status === 'PASS') { status = 'FAIL'; detail = extra; } else detail += ` [${extra}]`;
  }
  const row: Row = { n, name, status, ms: Date.now() - t0, detail };
  if (status === 'FAIL' && active && !active.isClosed()) {
    const file = path.join(SHOTS, `${String(n).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60)}.png`);
    try { await active.screenshot({ path: file, fullPage: true, timeout: 15_000 }); row.shot = file; } catch { /* page gone */ }
  }
  rows.push(row);
  console.log(`${status}  ${name}${detail ? `  (${detail.slice(0, 160)})` : ''}`);
}

async function until(what: string, fn: () => Promise<boolean>, timeout = 30_000, every = 500) {
  const end = Date.now() + timeout;
  let last: unknown = null;
  while (Date.now() < end) {
    try { if (await fn()) return; last = null; } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`timed out after ${Math.round(timeout / 1000)}s waiting for ${what}${last ? `: ${msg(last)}` : ''}`);
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---------- MCP over HTTP (same minimal JSON-RPC helper as scripts/mcp-smoke.ts) ----------

type Rpc = { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { code: number; message: string } };
type Call = { ok: boolean; text: string; data: any };

async function call(key: string, tool: string, args: Record<string, unknown> = {}): Promise<Call> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const txt = await res.text();
  const data = txt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
  let r: Rpc;
  try { r = JSON.parse(data.length ? data[data.length - 1] : txt) as Rpc; } catch { return { ok: false, text: `HTTP ${res.status}: ${txt.slice(0, 200)}`, data: null }; }
  if (r.error) return { ok: false, text: r.error.message, data: null };
  const text = (r.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  return { ok: !r.result?.isError, text, data: parsed };
}

async function mcp(key: string, tool: string, args: Record<string, unknown> = {}) {
  const r = await call(key, tool, args);
  if (!r.ok) throw new Error(`MCP ${tool} failed: ${r.text.slice(0, 200)}`);
  return r.data;
}

// ---------- browser helpers ----------

function watch(page: Page) {
  page.on('pageerror', e => bucket?.push(`pageerror: ${msg(e)}`));
  page.on('console', m => { if (m.type() === 'error') bucket?.push(`console: ${m.text().slice(0, 200)}`); });
  page.on('response', r => { if (r.status() >= 500) bucket?.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '').slice(0, 100)}`); });
  // The only confirm() in the app is "Move "<title>" to trash?". Accept it only for carousels this run created.
  page.on('dialog', d => (d.message().includes(TAG) ? d.accept() : d.dismiss()).catch(() => {}));
}

async function goto(page: Page, p: string) {
  const res = await page.goto(BASE + p, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  return res;
}

const pathOf = (page: Page) => new URL(page.url()).pathname;
const heading = (page: Page) => page.locator('main h1').first().innerText();

/** Scrolls every matching <img> into view (they lazy-load) and returns the ones that failed to decode. */
async function brokenImages(page: Page, selector: string, timeout = 30_000) {
  const imgs = page.locator(selector);
  const n = await imgs.count();
  for (let i = 0; i < n; i++) await imgs.nth(i).scrollIntoViewIfNeeded().catch(() => {});
  await until(`${n} images to finish loading`, async () => (await imgs.evaluateAll(els => els.every(e => (e as HTMLImageElement).complete))), timeout).catch(() => {});
  const bad = await imgs.evaluateAll(els => els.filter(e => !(e as HTMLImageElement).complete || (e as HTMLImageElement).naturalWidth === 0).map(e => (e as HTMLImageElement).src.slice(0, 120)));
  return { n, bad };
}

const cardByTitle = (page: Page, title: string) => page.locator('.card').filter({ has: page.locator('.card-title', { hasText: exact(title) }) });
const slidesOf = (page: Page) => page.locator('.slides > .slide');
const versionChip = (page: Page) => page.locator('.page-head .chip').filter({ hasText: /^v\d+ by / }).first();
const panel = (page: Page) => page.getByRole('complementary', { name: 'Notes and requests' });
const reqCard = (page: Page, text: string) => panel(page).locator('.req').filter({ has: page.locator('p', { hasText: exact(text) }) });

/** Refuses to mutate any carousel page that this run did not create. */
async function assertOwn(page: Page) {
  const h = await heading(page);
  assert(h.startsWith(TAG), `safety: refusing to act on carousel "${h}" (not created by this run)`);
}

async function pinNote(page: Page, slide: number, text: string) {
  await assertOwn(page);
  await page.getByRole('button', { name: `Slide ${slide}, click to pin a note` }).click({ position: { x: 120, y: 160 } });
  await page.getByLabel('Note', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Add note' }).click();
  await reqCard(page, text).waitFor({ timeout: 60_000 });
}

async function signIn(page: Page, password: string) {
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

// ---------- DB snapshots for safety checks ----------

const db = getDb();
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

async function brandState() {
  const [b] = await db.select().from(schema.brand).where(eq(schema.brand.id, 'default'));
  return b ? { hash: hash(b.pack), updatedAt: b.updatedAt.toISOString(), pack: b.pack as any } : null;
}

/** The owner's data = rows older than this run by over an hour (other test scripts' temp rows are newer). */
async function ownerState() {
  const cutoff = new Date(RUN_START.getTime() - 60 * 60_000);
  const cs = await db.select().from(schema.carousels).where(lt(schema.carousels.createdAt, cutoff));
  const ks = await db.select({ id: schema.apiKeys.id, name: schema.apiKeys.name }).from(schema.apiKeys).where(lt(schema.apiKeys.createdAt, cutoff));
  return {
    carousels: Object.fromEntries(cs.map(c => [c.id, { title: c.title, status: c.status, v: c.currentVersion, deleted: c.deletedAt?.toISOString() ?? null, updated: c.updatedAt.toISOString() }])),
    keys: Object.fromEntries(ks.map(k => [k.id, k.name])),
  };
}

// ---------- run state (everything here is cleaned up) ----------

const created = new Set<string>(); // carousel ids
const keyIds = new Set<string>();
const keyNames = new Set<string>();
const requestIds = new Set<string>();
const activityIds = new Set<string>();
const LAYOUT = TAG; // lowercase slug: a-z0-9-
let adminKey = '';

async function rememberActivity(carouselIds: string[]) {
  if (!carouselIds.length) return;
  const acts = await db.select({ id: schema.activity.id }).from(schema.activity).where(inArray(schema.activity.carouselId, carouselIds));
  acts.forEach(a => activityIds.add(a.id));
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  console.log(`UI e2e against ${BASE}  run ${TAG}  screenshots ${SHOTS}\n`);
  if (!PASSWORD) { console.error('STUDIO_PASSWORD is not set'); process.exit(2); }

  const brandBefore = await brandState();
  const ownerBefore = await ownerState();

  let browser: Browser | null = null;
  try {
    // temp admin key for the MCP side of the round trips and for cleanup
    adminKey = newApiKey();
    const adminName = `${TAG}-admin`;
    const [k] = await db.insert(schema.apiKeys).values({ name: adminName, hash: await sha256(adminKey), scopes: ['read', 'write', 'admin'] }).returning({ id: schema.apiKeys.id });
    keyIds.add(k.id); keyNames.add(adminName);

    browser = process.env.CHROME_PATH
      ? await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
      : await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
    const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    ctx.setDefaultTimeout(30_000);
    const page = await ctx.newPage();
    watch(page);
    active = page;

    // ================= 1. Auth =================
    await step('auth: signed-out /agents redirects to /login?next=/agents', async () => {
      await goto(page, '/agents');
      const u = new URL(page.url());
      assert(u.pathname === '/login', `landed on ${u.pathname}`);
      assert(u.searchParams.get('next') === '/agents', `next=${u.searchParams.get('next')}`);
    });
    await step('auth: wrong password shows an error', async () => {
      await signIn(page, `wrong-${RUN}`);
      await page.waitForURL(u => u.searchParams.get('error') === '1', { timeout: 30_000 });
      const alert = await page.locator('main').getByRole('alert').innerText(); // (Next's route announcer is also role=alert)
      assert(/wrong password/i.test(alert), `alert: "${alert}"`);
      assert(new URL(page.url()).searchParams.get('next') === '/agents', 'next lost after wrong password');
    });
    let signedIn = false;
    await step('auth: correct password signs in and returns to next', async () => {
      await signIn(page, PASSWORD);
      await page.waitForURL(u => u.pathname === '/agents', { timeout: 30_000 });
      assert((await heading(page)) === 'Agents', `heading ${await heading(page)}`);
      signedIn = true;
    });
    if (!signedIn) throw new Error('cannot sign in; stopping');

    // ================= 2. Gallery =================
    await step('gallery: cards render with cover images', async () => {
      await goto(page, '/');
      assert((await heading(page)) === 'Carousels', 'no Carousels heading');
      const cards = await page.locator('.grid > a.card').count();
      const total = Number((await page.locator('.page-head .muted').first().innerText()).match(/(\d+) total/)?.[1]);
      assert(cards > 0 && cards === total, `${cards} cards vs "${total} total"`);
      const { n, bad } = await brokenImages(page, '.thumb img');
      assert(bad.length === 0, `${bad.length}/${n} broken covers: ${bad[0]}`);
      return `${cards} cards, ${n} covers`;
    });
    await step('gallery: Trash tab /?trash=1 renders', async () => {
      await goto(page, '/?trash=1');
      assert((await heading(page)) === 'Trash', 'no Trash heading');
      const cards = await page.locator('.grid > .card').count();
      const said = Number((await page.locator('.page-head .muted').first().innerText()).match(/(\d+) in trash/)?.[1]);
      assert(cards === said, `${cards} cards vs "${said} in trash"`);
      const restore = await page.getByRole('button', { name: 'Restore' }).count();
      const purge = await page.getByRole('button', { name: 'Delete forever' }).count();
      assert(restore === cards && purge === cards, `buttons: ${restore} Restore, ${purge} Delete forever for ${cards} cards`);
      const { n, bad } = await brokenImages(page, '.thumb img');
      assert(bad.length === 0, `${bad.length}/${n} broken covers`);
      return `${cards} in trash`;
    });

    // ================= 3 + 6. New carousel: ask agents → Requests =================
    const PROMPT = `${TAG} prompt: native dialog element replaces modal libraries`;
    await step('new: "Send to agents" creates a request shown on /requests', async () => {
      await goto(page, '/new');
      await page.getByLabel('Prompt').fill(PROMPT);
      await page.getByRole('button', { name: 'Send to agents' }).click();
      await page.waitForURL(u => u.pathname === '/requests', { timeout: 60_000 });
      const [r] = await db.select().from(schema.requests).where(and(eq(schema.requests.kind, 'new'), eq(schema.requests.text, PROMPT)));
      if (r) requestIds.add(r.id);
      assert(r && r.status === 'open', `DB request: ${r ? r.status : 'missing'}`);
      await page.locator('section.panel').first().locator('.req', { hasText: PROMPT }).waitFor({ timeout: 15_000 });
    });
    await step('requests: prompt shows under Waiting and Dismiss removes it', async () => {
      if (pathOf(page) !== '/requests') await goto(page, '/requests');
      const card = page.locator('section.panel').first().locator('.req').filter({ has: page.locator('p', { hasText: exact(PROMPT) }) });
      await card.waitFor();
      assert((await card.locator('.chip').allInnerTexts()).includes('new carousel'), 'no "new carousel" chip');
      await card.getByRole('button', { name: 'Dismiss' }).click();
      await until('request to leave Waiting', async () => (await card.count()) === 0);
      const [r] = await db.select().from(schema.requests).where(eq(schema.requests.text, PROMPT));
      assert(r?.status === 'dismissed', `DB status ${r?.status}`);
    });

    // ================= 3 + 4. Blank canvas → carousel page =================
    const TITLE1 = `${TAG} blank canvas`;
    let c1: string | null = null;
    await step('new: "Create blank canvas" creates a design-only carousel and opens it', async () => {
      await goto(page, '/new');
      await page.getByLabel('Title').fill(TITLE1);
      await page.getByLabel(/^Number/).fill('999');
      await page.getByRole('button', { name: 'Create blank canvas' }).click();
      await page.waitForURL(u => /^\/c\/[0-9a-f-]{36}$/.test(u.pathname), { timeout: RENDER_MS });
      c1 = pathOf(page).slice(3);
      created.add(c1);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      assert((await heading(page)) === TITLE1, `heading "${await heading(page)}"`);
      const metas = await slidesOf(page).locator('.slide-meta .mono').allInnerTexts();
      assert(metas.length === 2, `${metas.length} slides, expected 2`);
      assert(metas.every(m => /^\d+ · design\b/.test(m)), `non-design slides: ${metas.join(' / ')}`);
      assert(await page.locator('.page-head .chip', { hasText: '#999' }).count(), 'no #999 tip chip');
      return metas.join(' / ');
    });
    await step('carousel: slides render (1080x1350 PNGs)', async () => {
      need(c1, 'blank carousel');
      const { n, bad } = await brokenImages(page, 'img[alt^="Slide "]', 60_000);
      assert(n === 2 && bad.length === 0, `${n} slide images, ${bad.length} broken`);
      const sizes = await page.locator('img[alt^="Slide "]').evaluateAll(els => els.map(e => `${(e as HTMLImageElement).naturalWidth}x${(e as HTMLImageElement).naturalHeight}`));
      assert(sizes.every(s => s === '1080x1350'), `sizes ${sizes.join(',')}`);
    });

    const EDITED = `Edited <mark>e2e</mark> ${RUN}`;
    await step('editor: Edit → design editor → Preview shows image + warnings (12px text)', async () => {
      need(c1, 'blank carousel');
      await assertOwn(page);
      await page.getByRole('button', { name: /^Edit/ }).click();
      await until('2 design editors', async () => (await page.locator('.design-edit').count()) === 2);
      const s1 = slidesOf(page).nth(0);
      await s1.locator('.design-edit textarea.code').nth(0).fill(`<h1 class="t-hook">${EDITED}</h1>\n<p class="tiny">tiny print ${RUN}</p>`);
      await s1.locator('.design-edit textarea.code').nth(1).fill('&{justify-content:center}\n.tiny{font-size:12px}');
      await s1.getByRole('button', { name: 'Preview' }).click();
      const img = s1.locator('img[alt="Design preview"]');
      await img.waitFor({ timeout: RENDER_MS });
      const w = await img.evaluate(e => (e as HTMLImageElement).naturalWidth);
      assert(w > 0, 'preview image did not decode');
      const errs = await s1.locator('.design-preview ul.error li').allInnerTexts();
      assert(errs.length === 0, `preview errors: ${errs.join('; ')}`);
      const warns = await s1.locator('.design-preview ul.muted li').allInnerTexts();
      assert(warns.some(x => /under 24px/.test(x)), `warnings list lacks the 12px finding: ${JSON.stringify(warns)}`);
      return `${warns.length} warning(s): ${warns[0]?.slice(0, 70)}`;
    });
    await step('editor: "Add slide" adds a blank design slide', async () => {
      need(c1, 'blank carousel');
      assert(await page.locator('.savebar').count(), 'not in edit mode');
      await page.getByLabel('Add slide').selectOption('design');
      await until('3 slides', async () => (await slidesOf(page).count()) === 3);
      const meta = await slidesOf(page).nth(1).locator('.slide-meta .mono').innerText();
      assert(/^2 · design · big number/.test(meta), `inserted slide meta "${meta}"`);
      assert((await page.locator('.design-edit').count()) === 3, 'new slide has no design editor');
    });
    await step('editor: "Save as new version" → v2 by you', async () => {
      need(c1, 'blank carousel');
      await page.getByLabel('What changed').fill(`${TAG} edit`);
      await page.getByRole('button', { name: 'Save as new version' }).click();
      const alert = page.locator('.savebar [role=alert]');
      await until('v2 chip (or a save error)', async () => (await alert.count()) > 0 || /^v2 by you$/.test((await versionChip(page).innerText()).trim()), RENDER_MS, 1000);
      if (await alert.count()) throw new Error(`save error: ${await alert.innerText()}`);
      assert((await page.locator('.savebar').count()) === 0, 'still in edit mode');
      assert((await slidesOf(page).count()) === 3, 'v2 should have 3 slides');
      const opts = await page.locator('#version option').allInnerTexts();
      assert(opts.length === 2 && opts.some(o => /^v2 · you \(current\)/.test(o)), `version options ${JSON.stringify(opts)}`);
      const { bad } = await brokenImages(page, 'img[alt^="Slide "]', 60_000);
      assert(bad.length === 0, `${bad.length} broken slide images`);
    });
    await step('lint: warnings badge shows on the 12px design slide', async () => {
      need(c1, 'blank carousel');
      const badge = slidesOf(page).nth(0).locator('.lint-badge summary');
      await badge.waitFor({ timeout: 15_000 });
      const label = await badge.innerText();
      assert(/^\d+ (warning|issue)s?$/.test(label.trim()), `badge "${label}"`);
      await badge.click();
      const items = await slidesOf(page).nth(0).locator('.lint-badge li').allInnerTexts();
      assert(items.some(x => /under 24px/.test(x)), `badge items ${JSON.stringify(items)}`);
      const others = await slidesOf(page).nth(2).locator('.lint-badge').count();
      return `slide 1: "${label}"; slide 3 badge: ${others ? 'yes' : 'none'}`;
    });
    await step('versions: selector switches back to v1 and forward to v2', async () => {
      need(c1, 'blank carousel');
      await page.locator('#version').selectOption('1');
      await page.waitForURL(u => u.searchParams.get('v') === '1', { timeout: 30_000 });
      await until('v1 chip', async () => /^v1 by you · not current$/.test((await versionChip(page).innerText()).trim()));
      assert((await slidesOf(page).count()) === 2, 'v1 should have 2 slides');
      assert(await page.getByRole('button', { name: 'Use this version' }).isVisible(), 'no "Use this version" on an old version');
      await page.locator('#version').selectOption('2');
      await page.waitForURL(u => u.searchParams.get('v') === '2', { timeout: 30_000 });
      await until('v2 chip', async () => /^v2 by you$/.test((await versionChip(page).innerText()).trim()));
      assert((await slidesOf(page).count()) === 3, 'v2 should have 3 slides');
    });
    await step('carousel: Re-render completes', async () => {
      need(c1, 'blank carousel');
      await assertOwn(page);
      const before = await db.select({ n: schema.activity.id }).from(schema.activity).where(and(eq(schema.activity.carouselId, c1!), eq(schema.activity.action, 'render_carousel')));
      await page.getByRole('button', { name: 'Re-render' }).click();
      await until('render_carousel activity', async () => (await db.select({ n: schema.activity.id }).from(schema.activity).where(and(eq(schema.activity.carouselId, c1!), eq(schema.activity.action, 'render_carousel')))).length > before.length, RENDER_MS, 2000);
      await until('Re-render button idle', async () => page.getByRole('button', { name: 'Re-render' }).isEnabled(), 30_000);
      const { bad } = await brokenImages(page, 'img[alt^="Slide "]', 60_000);
      assert(bad.length === 0, `${bad.length} broken slide images after re-render`);
    });
    await step('status: Approve → Mark posted → Back to review', async () => {
      need(c1, 'blank carousel');
      await assertOwn(page);
      const chip = (s: string) => page.locator(`.page-head .chip.${s}`);
      await page.getByRole('button', { name: 'Approve' }).click();
      await chip('approved').waitFor({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Mark posted' }).click();
      await chip('posted').waitFor({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Back to review' }).click();
      await chip('review').waitFor({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Approve' }).waitFor();
      const [c] = await db.select().from(schema.carousels).where(eq(schema.carousels.id, c1!));
      assert(c.status === 'review', `DB status ${c.status}`);
    });
    const NOTE1 = `${TAG} note: make the headline bigger`;
    await step('notes: click slide 2 → note in "Notes for agents" → Dismiss', async () => {
      need(c1, 'blank carousel');
      await pinNote(page, 2, NOTE1);
      const card = reqCard(page, NOTE1);
      const chips = await card.locator('.chip').allInnerTexts();
      assert(chips.includes('slide 2 · v2') && chips.includes('open'), `chips ${JSON.stringify(chips)}`);
      const pins = slidesOf(page).nth(1).locator(`.pin[title="${NOTE1}"]`);
      assert((await pins.count()) === 1, 'no pin marker on slide 2');
      const [r] = await db.select().from(schema.requests).where(eq(schema.requests.text, NOTE1));
      if (r) requestIds.add(r.id);
      await card.getByRole('button', { name: 'Dismiss' }).click();
      await until('note to disappear', async () => (await card.count()) === 0 && (await pins.count()) === 0);
    });
    await step('activity: lists my actions with actor "you"', async () => {
      need(c1, 'blank carousel');
      await goto(page, `/c/${c1}`);
      const text = await panel(page).innerText();
      const want = ['create carousel', 'update slides', 'render carousel', 'update carousel', 'add note', 'dismiss request'];
      const missing = want.filter(a => !new RegExp(`(^|\\n)you ${a} ·`).test(text));
      assert(missing.length === 0, `missing: ${missing.join(', ')}`);
    });
    let copy: string | null = null;
    const COPY = `${TITLE1} (copy)`;
    await step('Duplicate opens the copy', async () => {
      need(c1, 'blank carousel');
      await assertOwn(page);
      await page.getByRole('button', { name: 'Duplicate' }).click();
      await page.waitForURL(u => /^\/c\/[0-9a-f-]{36}$/.test(u.pathname) && u.pathname !== `/c/${c1}`, { timeout: RENDER_MS });
      copy = pathOf(page).slice(3);
      created.add(copy);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      assert((await heading(page)) === COPY, `heading "${await heading(page)}"`);
      const { n, bad } = await brokenImages(page, 'img[alt^="Slide "]', 60_000);
      assert(n === 3 && bad.length === 0, `${n} images, ${bad.length} broken`);
    });
    await step('Delete moves the copy to the trash', async () => {
      need(copy, 'duplicate');
      if (pathOf(page) !== `/c/${copy}`) await goto(page, `/c/${copy}`);
      await assertOwn(page);
      const t0 = Date.now();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.waitForURL(u => u.pathname === '/', { timeout: 60_000 });
      const t1 = Date.now();
      const staleAtRedirect = await cardByTitle(page, COPY).count();
      await until('copy gone from gallery', async () => (await cardByTitle(page, COPY).count()) === 0);
      assert(await cardByTitle(page, TITLE1).count(), 'original vanished from gallery');
      return `redirect ${((t1 - t0) / 1000).toFixed(1)}s, card gone ${((Date.now() - t1) / 1000).toFixed(1)}s later${staleAtRedirect ? ' (gallery briefly still listed it)' : ''}`;
    });
    await step('Trash shows it → Restore → back in gallery', async () => {
      need(copy, 'duplicate');
      await goto(page, '/?trash=1');
      const card = cardByTitle(page, COPY);
      await card.waitFor({ timeout: 15_000 });
      await card.getByRole('button', { name: 'Restore' }).click();
      await until('copy gone from trash', async () => (await card.count()) === 0);
      await goto(page, '/');
      assert(await cardByTitle(page, COPY).count(), 'restored copy not in gallery');
    });
    await step('Delete again → "Delete forever" removes it', async () => {
      need(copy, 'duplicate');
      await goto(page, `/c/${copy}`);
      await assertOwn(page);
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.waitForURL(u => u.pathname === '/', { timeout: 60_000 });
      await goto(page, '/?trash=1');
      const card = cardByTitle(page, COPY);
      await card.waitFor({ timeout: 15_000 });
      await rememberActivity([copy!]);
      await card.getByRole('button', { name: 'Delete forever' }).click();
      await until('copy gone from trash', async () => (await card.count()) === 0);
      const rowsLeft = await db.select({ id: schema.carousels.id }).from(schema.carousels).where(eq(schema.carousels.id, copy!));
      assert(rowsLeft.length === 0, 'carousel row still in DB');
    });

    // ================= 5. MCP ↔ UI round trip =================
    const TITLE2 = `${TAG} via mcp`;
    let c2: string | null = null;
    await step('mcp: create_carousel (design slides) → appears in gallery', async () => {
      const r = await mcp(adminKey, 'create_carousel', {
        title: TITLE2,
        note: `${TAG} created over MCP`,
        slides: [
          { kind: 'design', name: 'e2e cover', html: '<h1 class="t-hook">MCP <mark>round trip</mark></h1>' },
          { kind: 'design', name: 'e2e body', html: '<h2 class="t-title">Second slide</h2>' },
          { kind: 'design', name: 'e2e end', html: '<h2 class="t-title">Third slide</h2>' },
        ],
      });
      c2 = r?.id ?? null;
      if (c2) created.add(c2);
      assert(c2, `no id: ${JSON.stringify(r).slice(0, 200)}`);
      await goto(page, '/');
      const card = cardByTitle(page, TITLE2);
      await card.waitFor({ timeout: 15_000 });
      const { n, bad } = await brokenImages(page, `a.card[href="/c/${c2}"] .thumb img`);
      assert(n === 1 && bad.length === 0, `cover: ${n} img, ${bad.length} broken`);
    });
    await step('mcp: its carousel page renders (3 slides, v1 by the agent key)', async () => {
      need(c2, 'MCP carousel');
      await cardByTitle(page, TITLE2).click();
      await page.waitForURL(u => u.pathname === `/c/${c2}`);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      const { n, bad } = await brokenImages(page, 'img[alt^="Slide "]', 60_000);
      assert(n === 3 && bad.length === 0, `${n} images, ${bad.length} broken`);
      const chip = (await versionChip(page).innerText()).trim();
      assert(chip === `v1 by ${TAG}-admin`, `chip "${chip}"`);
    });
    const NOTE2 = `${TAG} note: tighten slide 3`;
    await step('mcp: note added in the UI → list_requests sees it on slide 3', async () => {
      need(c2, 'MCP carousel');
      await pinNote(page, 3, NOTE2);
      const reqs = await mcp(adminKey, 'list_requests', { carouselId: c2 });
      const r = (reqs as any[]).find(x => x.text === NOTE2);
      if (r?.id) requestIds.add(r.id);
      assert(r, `note not in list_requests (${(reqs as any[]).length} items)`);
      assert(r.slide === 3 && r.versionNumber === 1 && r.kind === 'note' && r.status === 'open', `got slide=${r.slide} v=${r.versionNumber} kind=${r.kind} status=${r.status}`);
      assert(r.x > 0 && r.x < 1 && r.y > 0 && r.y < 1, `x/y ${r.x},${r.y}`);
    });
    await step('mcp: edit_slide → UI shows the new version', async () => {
      need(c2, 'MCP carousel');
      const before = await page.locator('img[alt="Slide 1"]').getAttribute('src');
      const r = await mcp(adminKey, 'edit_slide', { id: c2, slide: 1, patch: { html: `<h1 class="t-hook">Edited via <mark>MCP</mark> ${RUN}</h1>` }, note: `${TAG} mcp edit` });
      assert(r?.version === 2, `edit_slide version ${r?.version}`);
      await page.reload({ waitUntil: 'load' });
      await until('v2 chip', async () => (await versionChip(page).innerText()).trim() === `v2 by ${TAG}-admin`, 30_000);
      const opts = await page.locator('#version option').allInnerTexts();
      assert(opts.some(o => o.startsWith(`v2 · ${TAG}-admin (current)`)), `options ${JSON.stringify(opts)}`);
      const after = await page.locator('img[alt="Slide 1"]').getAttribute('src');
      assert(after && after !== before, 'slide 1 image URL did not change');
      assert(await reqCard(page, NOTE2).count(), 'v1 note no longer listed in the panel');
    });

    // ================= 7. Agents =================
    const scopes = [
      { level: 'read', chips: ['read'] },
      { level: 'write', chips: ['read', 'write'] },
      { level: 'admin', chips: ['read', 'write', 'admin'] },
    ];
    const keyRow = (name: string) => page.locator('.req').filter({ has: page.locator('b', { hasText: exact(name) }) });
    for (const s of scopes) {
      const name = `${TAG}-ui-${s.level}`;
      await step(`agents: create ${s.level} key → shown once + scope chips`, async () => {
        if (pathOf(page) !== '/agents') await goto(page, '/agents');
        await page.getByLabel('Agent name').fill(name);
        await page.getByLabel('Access').selectOption(s.level);
        await page.getByRole('button', { name: 'Create key' }).click();
        await page.getByText(`The key for ${name} is shown only once`).waitFor({ timeout: 30_000 });
        keyNames.add(name);
        const [row] = await db.select({ id: schema.apiKeys.id }).from(schema.apiKeys).where(eq(schema.apiKeys.name, name));
        if (row) keyIds.add(row.id);
        const snippet = await page.locator('form textarea[readonly]').inputValue();
        const key = snippet.match(/Bearer (ks_[A-Za-z0-9_-]+)/)?.[1];
        assert(key, 'no "Bearer ks_…" in the snippet');
        assert(snippet.includes(ENDPOINT), `snippet lacks ${ENDPOINT}`);
        await until('key in the list', async () => (await keyRow(name).count()) === 1);
        const chips = await keyRow(name).locator('.chip').allInnerTexts();
        assert(JSON.stringify(chips) === JSON.stringify(s.chips), `chips ${JSON.stringify(chips)}`);
        await goto(page, '/agents');
        assert(!(await page.content()).includes(key), 'key still visible after reload');
        assert((await keyRow(name).count()) === 1, 'key row missing after reload');
      });
    }
    await step('agents: Revoke removes each test key', async () => {
      const names = scopes.map(s => `${TAG}-ui-${s.level}`);
      if (pathOf(page) !== '/agents') await goto(page, '/agents');
      for (const name of names) {
        const row = keyRow(name);
        if (!(await row.count())) throw new Skip(`key ${name} not created`);
        await row.getByRole('button', { name: 'Revoke' }).click();
        await until(`${name} gone`, async () => (await row.count()) === 0);
      }
      const left = await db.select({ id: schema.apiKeys.id }).from(schema.apiKeys).where(inArray(schema.apiKeys.name, names));
      assert(left.length === 0, `${left.length} keys still in DB`);
    });
    await step('agents: "Connect a web app" shows the MCP URL; Connected apps renders', async () => {
      await goto(page, '/agents');
      const card = page.locator('section.form-card').filter({ has: page.getByRole('heading', { name: 'Connect a web app' }) });
      const text = await card.innerText();
      assert(text.includes(ENDPOINT), `card lacks ${ENDPOINT}`);
      await page.getByRole('heading', { name: 'Connected apps', level: 3 }).waitFor();
      const conn = page.locator('section.form-card').filter({ has: page.getByRole('heading', { name: 'Connected apps' }) });
      const empty = await conn.getByText('No web apps connected.').count();
      const apps = await conn.getByRole('button', { name: 'Disconnect' }).count();
      assert(empty === 1 || apps > 0, 'neither empty state nor app rows');
      return apps ? `${apps} connected app(s)` : 'no apps connected';
    });

    // ================= 8. Brand (read-only + rejected validation) =================
    await step('brand: page shows the current brand (name, colors, fonts)', async () => {
      const b = need(brandBefore, 'brand row');
      await goto(page, '/brand');
      assert((await heading(page)) === 'Brand', 'no Brand heading');
      const name = await page.locator('section.form-card h2').first().innerText();
      assert(name === b.pack.name, `shows "${name}", DB has "${b.pack.name}"`);
      const sw = await page.locator('.swatches .sw').count();
      assert(sw === ROLES.length, `${sw} swatches, ${ROLES.length} roles`);
      const families = [...new Set(((b.pack.fonts ?? []) as { family: string }[]).map(f => f.family))];
      const fontsLine = await page.locator('section.form-card p.muted', { hasText: 'Fonts:' }).innerText();
      const missing = families.filter(f => !fontsLine.includes(f));
      assert(missing.length === 0, `fonts missing: ${missing.join(', ')}`);
      assert((await page.getByLabel('Brand name').inputValue()) === b.pack.name, 'form name differs');
      assert((await page.getByLabel('Handle on slides').inputValue()) === b.pack.handle, 'form handle differs');
      return `${b.pack.name}; fonts: ${families.join(', ') || 'none'}`;
    });
    await step('brand: invalid roles JSON is rejected and the brand is unchanged', async () => {
      need(brandBefore, 'brand row');
      if (pathOf(page) !== '/brand') await goto(page, '/brand');
      const before = await brandState();
      await page.getByLabel(/^Color roles/).fill(`{ not json ${RUN}`);
      await page.getByRole('button', { name: 'Save details' }).click();
      const alert = page.locator('form').getByRole('alert');
      await alert.waitFor({ timeout: 30_000 });
      const t1 = await alert.innerText();
      assert(/valid JSON/i.test(t1), `alert "${t1}"`);
      await page.getByLabel(/^Color roles/).fill(`{"zz-e2e-bogus": "x"}`);
      await page.getByRole('button', { name: 'Save details' }).click();
      await until('unknown-role error', async () => /Unknown roles: zz-e2e-bogus/.test(await alert.innerText()));
      const after = await brandState();
      assert(before && after && before.hash === after.hash && before.updatedAt === after.updatedAt, 'BRAND ROW CHANGED');
      await goto(page, '/brand'); // drop the unsaved form state
    });

    // ================= 9. Layouts =================
    await step('layouts: page renders (empty state or grid)', async () => {
      await goto(page, '/layouts');
      assert((await heading(page)) === 'Layouts', 'no Layouts heading');
      const err = await page.locator('main [role=alert]').count();
      assert(err === 0, `error: ${err && (await page.locator('main [role=alert]').innerText())}`);
      const cards = await page.locator('.grid > .card').count();
      const empty = await page.getByText('No layouts yet').count();
      assert(cards > 0 || empty === 1, 'neither grid nor empty state');
      return cards ? `${cards} layouts` : 'empty state';
    });
    await step('layouts: MCP save_layout shows up; Delete removes it', async () => {
      await mcp(adminKey, 'save_layout', { name: LAYOUT, description: `${TAG} layout`, html: '<h1 class="t-hook">{{title}}</h1>' });
      await goto(page, '/layouts');
      const card = cardByTitle(page, LAYOUT);
      await card.waitFor({ timeout: 15_000 });
      const chips = await card.locator('.chip').allInnerTexts();
      assert(chips.includes('{{title}}'), `chips ${JSON.stringify(chips)}`);
      const thumbs = await brokenImages(page, `img[alt="${LAYOUT} thumbnail"]`);
      assert(thumbs.bad.length === 0, 'broken thumbnail');
      await card.getByRole('button', { name: 'Delete' }).click();
      await until('layout card gone', async () => (await card.count()) === 0);
      const left = await db.select({ id: schema.layouts.id }).from(schema.layouts).where(eq(schema.layouts.name, LAYOUT));
      assert(left.length === 0, 'layout still in DB');
      return thumbs.n ? 'with thumbnail' : 'no thumbnail';
    });

    // ================= 10. OAuth consent error page =================
    await step('oauth: unknown client shows "Can\'t connect this app" and does not redirect', async () => {
      const foreign: string[] = [];
      const onReq = (r: { url(): string }) => { if (!r.url().startsWith(BASE)) foreign.push(r.url()); };
      page.on('request', onReq);
      try {
        const q = new URLSearchParams({ client_id: `${TAG}-unknown-client`, redirect_uri: 'https://example.com/e2e-callback', response_type: 'code', state: RUN, code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', scope: 'read' });
        await goto(page, `/oauth/authorize?${q}`);
        const u = new URL(page.url());
        assert(u.origin === new URL(BASE).origin && u.pathname === '/oauth/authorize', `navigated to ${u.origin}${u.pathname}`);
        const h = await page.locator('h1').first().innerText();
        assert(/Can.t connect this app/.test(h), `heading "${h}"`);
        const alert = await page.locator('main').getByRole('alert').innerText();
        assert(/Unknown client/i.test(alert), `alert "${alert.slice(0, 100)}"`);
        assert((await page.getByRole('button', { name: 'Allow' }).count()) === 0, 'consent buttons shown');
        await sleep(1000);
        assert(foreign.length === 0, `requests to other origins: ${foreign.slice(0, 2).join(', ')}`);
      } finally { page.off('request', onReq); }
    });

    // ================= 11. Phone viewport =================
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
    try {
      const mp = await phone.newPage();
      watch(mp);
      active = mp;
      const overflow = async (p: string) => {
        await goto(mp, p);
        const r = await mp.evaluate(() => {
          const W = document.documentElement.clientWidth;
          const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
          const culprits = sw > W + 1
            ? [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > W + 1).slice(0, 3).map(e => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).split(' ')[0]}`)
            : [];
          return { W, sw, culprits };
        });
        assert(r.sw <= r.W + 1, `horizontal overflow: scrollWidth ${r.sw} > ${r.W} (${r.culprits.join(', ')})`);
        return `${r.W}px wide`;
      };
      await step('phone 390x844: gallery has no horizontal overflow', async () => {
        const res = await overflow('/');
        assert(await mp.locator('.card').count(), 'no cards');
        return res;
      });
      await step('phone 390x844: carousel page has no horizontal overflow', async () => {
        const res = await overflow(`/c/${need(c2 ?? c1, 'a test carousel')}`);
        const { n, bad } = await brokenImages(mp, 'img[alt^="Slide "]', 60_000);
        assert(n > 0 && bad.length === 0, `${n} slide images, ${bad.length} broken`);
        return res;
      });
    } finally {
      active = page;
      await phone.close();
    }

    // ================= 1 (end). Sign out =================
    await step('auth: Sign out → protected pages redirect to /login again', async () => {
      await goto(page, '/');
      await page.getByRole('button', { name: 'Sign out' }).click();
      await page.waitForURL(u => u.pathname === '/login', { timeout: 30_000 });
      await goto(page, '/requests');
      const u = new URL(page.url());
      assert(u.pathname === '/login' && u.searchParams.get('next') === '/requests', `after sign out /requests → ${u.pathname}${u.search}`);
    });
  } catch (err) {
    rows.push({ n: rows.length + 1, name: 'suite aborted', status: 'FAIL', ms: 0, detail: msg(err) });
  } finally {
    active = null;
    await browser?.close().catch(() => {});
    await cleanup();
  }

  // ---------- verify nothing is left and the owner's data is untouched ----------
  await verify(brandBefore, ownerBefore);
  report();
}

async function cleanup() {
  const fail = (what: string, e: unknown) => rows.push({ n: rows.length + 1, name: `cleanup: ${what}`, status: 'FAIL', ms: 0, detail: msg(e) });
  try {
    // carousels: tracked ids + anything titled with this run's tag (e.g. a copy whose id was never captured)
    const tagged = await db.select({ id: schema.carousels.id }).from(schema.carousels).where(like(schema.carousels.title, `${TAG}%`));
    tagged.forEach(t => created.add(t.id));
    await rememberActivity([...created]);
    for (const id of created) {
      try {
        const [c] = await db.select().from(schema.carousels).where(eq(schema.carousels.id, id));
        if (!c) continue;
        assert(c.title.startsWith(TAG), `refusing to purge "${c.title}"`);
        let gone = false;
        if (adminKey) {
          if (!c.deletedAt) await call(adminKey, 'delete_carousel', { id });
          gone = (await call(adminKey, 'purge_carousel', { id })).ok;
        }
        if (!gone) { // fallback: direct DB delete + Blob sweep
          if (process.env.BLOB_READ_WRITE_TOKEN) {
            const pg = await list({ prefix: `carousels/${id}/` });
            if (pg.blobs.length) await del(pg.blobs.map(b => b.url));
          }
          await db.delete(schema.carousels).where(eq(schema.carousels.id, id));
        }
      } catch (e) { fail(`carousel ${id}`, e); }
    }
  } catch (e) { fail('carousels', e); }
  try {
    const [l] = await db.select().from(schema.layouts).where(eq(schema.layouts.name, LAYOUT));
    if (l) {
      if (!(adminKey && (await call(adminKey, 'delete_layout', { name: LAYOUT })).ok)) {
        await db.delete(schema.layouts).where(eq(schema.layouts.name, LAYOUT));
        if (l.thumbnail) await del(l.thumbnail).catch(() => {});
      }
    }
  } catch (e) { fail('layout', e); }
  try {
    const reqs = await db.select({ id: schema.requests.id }).from(schema.requests).where(like(schema.requests.text, `${TAG}%`));
    reqs.forEach(r => requestIds.add(r.id));
    if (requestIds.size) await db.delete(schema.requests).where(inArray(schema.requests.id, [...requestIds]));
  } catch (e) { fail('requests', e); }
  try {
    const ks = await db.select({ id: schema.apiKeys.id, name: schema.apiKeys.name }).from(schema.apiKeys).where(like(schema.apiKeys.name, `${TAG}%`));
    ks.forEach(k => { keyIds.add(k.id); keyNames.add(k.name); });
    if (ks.length) await db.delete(schema.apiKeys).where(inArray(schema.apiKeys.id, ks.map(k => k.id)));
  } catch (e) { fail('keys', e); }
  try {
    for (const id of await strayActivity()) activityIds.add(id);
    if (activityIds.size) await db.delete(schema.activity).where(inArray(schema.activity.id, [...activityIds]));
    if (keyNames.size) await db.delete(schema.activity).where(inArray(schema.activity.actor, [...keyNames]));
  } catch (e) { fail('activity', e); }
}

/** Activity rows from this run that no longer point at a carousel: matched by this run's tag or ids in actor/detail. */
async function strayActivity() {
  const tokens = [TAG, ...created, ...requestIds, ...keyIds];
  const recent = await db.select().from(schema.activity).where(gte(schema.activity.createdAt, RUN_START));
  return recent.filter(a => keyNames.has(a.actor) || (a.carouselId && created.has(a.carouselId)) || tokens.some(t => JSON.stringify(a.detail ?? {}).includes(t))).map(a => a.id);
}

async function verify(brandBefore: Awaited<ReturnType<typeof brandState>>, ownerBefore: Awaited<ReturnType<typeof ownerState>>) {
  const check = (name: string, ok: boolean, failDetail = '', okDetail = '') => rows.push({ n: rows.length + 1, name: `verify: ${name}`, status: ok ? 'PASS' : 'FAIL', ms: 0, detail: ok ? okDetail : failDetail || 'failed' });
  try {
    const cs = await db.select({ id: schema.carousels.id, title: schema.carousels.title }).from(schema.carousels).where(like(schema.carousels.title, 'zz-e2e%'));
    const ids = created.size ? await db.select({ id: schema.carousels.id }).from(schema.carousels).where(inArray(schema.carousels.id, [...created])) : [];
    check('no test carousels left (incl. trash)', cs.length === 0 && ids.length === 0, `left: ${cs.map(c => c.title).join(', ')} (${ids.length} tracked ids)`, `${created.size} created, all purged`);
    let blobs = 0;
    if (process.env.BLOB_READ_WRITE_TOKEN) for (const id of created) blobs += (await list({ prefix: `carousels/${id}/` })).blobs.length;
    check('no test blobs left', blobs === 0, `${blobs} blobs`);
    const rq = await db.select({ id: schema.requests.id }).from(schema.requests).where(like(schema.requests.text, 'zz-e2e%'));
    check('no test requests left', rq.length === 0, `${rq.length} left`);
    const ks = await db.select({ name: schema.apiKeys.name }).from(schema.apiKeys).where(like(schema.apiKeys.name, 'zz-e2e%'));
    check('no test keys left', ks.length === 0, ks.map(k => k.name).join(', '));
    const ls = await db.select({ name: schema.layouts.name }).from(schema.layouts).where(like(schema.layouts.name, 'zz-e2e%'));
    check('no test layouts left', ls.length === 0, ls.map(l => l.name).join(', '));
    const acts = await strayActivity();
    check('no test activity rows left', acts.length === 0, `${acts.length} rows left`, `${activityIds.size} rows deleted`);
    const brandAfter = await brandState();
    check('brand row unchanged', !!brandBefore && !!brandAfter && brandBefore.hash === brandAfter.hash && brandBefore.updatedAt === brandAfter.updatedAt,
      brandAfter?.updatedAt !== brandBefore?.updatedAt ? `updatedAt ${brandBefore?.updatedAt} → ${brandAfter?.updatedAt} (another script may have touched it)` : '');
    const ownerAfter = await ownerState();
    const changed = Object.entries(ownerBefore.carousels).filter(([id, v]) => JSON.stringify(ownerAfter.carousels[id]) !== JSON.stringify(v)).map(([, v]) => v.title);
    check(`owner carousels untouched (${Object.keys(ownerBefore.carousels).length} incl. trash)`, changed.length === 0, `changed: ${changed.join(', ')}`);
    const lostKeys = Object.entries(ownerBefore.keys).filter(([id]) => !ownerAfter.keys[id]).map(([, n]) => n);
    check(`owner keys untouched (${Object.keys(ownerBefore.keys).length})`, lostKeys.length === 0, `missing: ${lostKeys.join(', ')}`);
  } catch (e) {
    check('verification query', false, msg(e));
  }
}

function report() {
  const w = Math.max(...rows.map(r => r.name.length));
  console.log(`\n${'#'.padStart(3)}  ${'RESULT'}  ${'STEP'.padEnd(w)}  ${'TIME'.padStart(6)}  DETAIL`);
  for (const r of rows) {
    console.log(`${String(r.n).padStart(3)}  ${r.status.padEnd(6)}  ${r.name.padEnd(w)}  ${(r.ms ? `${(r.ms / 1000).toFixed(1)}s` : '').padStart(6)}  ${r.detail.replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  const shots = rows.filter(r => r.shot);
  if (shots.length) console.log(`\nFailure screenshots:\n${shots.map(r => `  #${r.n} ${r.shot}`).join('\n')}`);
  const fails = rows.filter(r => r.status === 'FAIL').length;
  const skips = rows.filter(r => r.status === 'SKIP').length;
  console.log(`\n${rows.length - fails - skips}/${rows.length} passed${fails ? `, ${fails} FAILED` : ''}${skips ? `, ${skips} skipped` : ''}  (${BASE}, run ${TAG})`);
  process.exit(fails ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
