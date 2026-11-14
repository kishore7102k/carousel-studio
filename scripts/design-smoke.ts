/* eslint-disable @typescript-eslint/no-explicit-any -- tool results are untyped JSON */
// Phase 3 design smoke test, over MCP against the dev server (spec section 6.2).
//   npm run design:smoke            (STUDIO_URL, default http://localhost:3000)
// Creates a temp admin key, carousels, assets, layouts and previews; removes them all in `finally`.
// A node:http request catcher on 127.0.0.1 must receive ZERO requests from hostile slides.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { eq, inArray, like } from 'drizzle-orm';
import { list, del } from '@vercel/blob';
import { getDb, schema } from '@/db';
import { newApiKey, sha256 } from '@/lib/auth';

const BASE = process.env.STUDIO_URL?.replace(/\/+$/, '') || 'http://localhost:3000';
const ENDPOINT = `${BASE}/api/mcp`;
const RUN = Math.random().toString(36).slice(2, 8);

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];
const check = (name: string, ok: boolean, detail = '') => { rows.push({ name, ok, detail: ok ? '' : detail }); };

// ---------- MCP over HTTP ----------

async function rpc(key: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }),
  });
  const txt = await res.text();
  const data = txt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
  const raw = data.length ? data[data.length - 1] : txt;
  try { return JSON.parse(raw); } catch { return { error: { code: res.status, message: raw.slice(0, 300) } }; }
}

type Call = { ok: boolean; text: string; data: any; images: number };
async function call(key: string, tool: string, args: Record<string, unknown> = {}): Promise<Call> {
  const r = await rpc(key, 'tools/call', { name: tool, arguments: args });
  if (r.error) return { ok: false, text: r.error.message ?? JSON.stringify(r.error), data: null, images: 0 };
  const content: { type: string; text?: string }[] = r.result?.content ?? [];
  const text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
  return { ok: !r.result?.isError, text, data: jsonIn(text), images: content.filter(c => c.type === 'image').length };
}

/** Parses the text as JSON, or the first {...} block inside it (tools may add prose around the JSON). */
function jsonIn(text: string): any {
  try { return JSON.parse(text); } catch { /* try block */ }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* none */ } }
  return null;
}
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const errorsOf = (c: Call) => arr(c.data?.errors);
const warningsOf = (c: Call) => arr(c.data?.warnings);

// ---------- helpers ----------

function crc32(buf: Buffer): number {
  let c, crc = ~0;
  for (const byte of buf) { c = (crc ^ byte) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A real, valid 3x2 RGB PNG. */
function tinyPng(): Buffer {
  const w = 3, h = 2;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x4f)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- cleanup state ----------

const keyNames: string[] = [];
const carouselIds = new Set<string>();
const assetIds = new Set<string>();
const layoutNames = new Set<string>();
const previewUrls = new Set<string>();

async function makeKey(label: string) {
  const name = `smoke-${label}-${RUN}`;
  const key = newApiKey();
  await getDb().insert(schema.apiKeys).values({ name, hash: await sha256(key), scopes: ['read', 'write', 'admin'] });
  keyNames.push(name);
  return key;
}

/** Remember any Blob URLs a tool result mentions under previews/ so cleanup can delete them. */
function trackPreviews(c: Call) { for (const m of c.text.matchAll(/https?:\/\/[^\s"')]+\/previews\/[^\s"')]+/g)) previewUrls.add(m[0]); }
async function preview(A: string, slide: unknown, extra: Record<string, unknown> = {}) {
  const c = await call(A, 'preview_slide', { slide, ...extra });
  trackPreviews(c);
  return c;
}

async function main() {
  const db = getDb();
  const hits: string[] = [];
  const catcher: Server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.statusCode = 200; res.end('x'); });
  await new Promise<void>(r => catcher.listen(0, '127.0.0.1', r));
  const PORT = (catcher.address() as AddressInfo).port;
  const HOST = `http://127.0.0.1:${PORT}`;

  try {
    const A = await makeKey('admin');
    const init = await rpc(A, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'design-smoke', version: '1' } });
    check('initialize', !!init.result && !init.error, JSON.stringify(init.error));

    const tl = await rpc(A, 'tools/list');
    const names = new Set<string>((tl.result?.tools ?? []).map((t: { name: string }) => t.name));
    const NEED = ['preview_slide', 'get_slide_source', 'upload_asset', 'list_assets', 'delete_asset', 'save_layout', 'list_layouts', 'get_layout', 'delete_layout', 'get_design_system'];
    const missing = NEED.filter(n => !names.has(n));
    check('tools/list has the Phase 3 tools', missing.length === 0, `missing: ${missing.join(', ')}`);

    // ---- 1. valid design slide ----
    const VALID = {
      kind: 'design', name: 'big number',
      html: '<div class="stat"><div class="num">10x</div><h2>Faster with <span class="mark">one change</span></h2></div>',
      css: '.stat{position:absolute;inset:96px;display:flex;flex-direction:column;justify-content:center;gap:24px}.num{font-size:320px;line-height:1;font-weight:700;color:var(--primary)}h2{font-size:64px;margin:0;color:var(--ink)}',
    };
    const pv = await preview(A, VALID);
    check('preview valid design: ok, image returned', pv.ok && pv.images >= 1, pv.text.slice(0, 200));
    check('preview valid design: no errors', pv.ok && pv.data !== null && errorsOf(pv).length === 0, pv.text.slice(0, 300));

    // ---- 2. overflow ----
    // lint errors on CONTENT (text/media) off the canvas; an oversized background box is just clipped (allowed)
    const OVER = { kind: 'design', html: '<h1 class="t-title off">Text pushed below the slide</h1>', css: '.off{margin-top:1500px}' };
    const po = await preview(A, OVER);
    check('preview overflowing slide: reports an error', po.ok && errorsOf(po).length > 0, po.text.slice(0, 300));
    const saveOver = await call(A, 'create_carousel', { title: `smoke design overflow ${RUN}`, slides: [{ kind: 'cover', hook: 'Smoke *cover*' }, OVER, { kind: 'cta', hook: 'Save *it*' }], render: false });
    if (saveOver.data?.id) carouselIds.add(saveOver.data.id);
    check('saving an overflowing slide is refused', !saveOver.ok, saveOver.text.slice(0, 200));

    // ---- 3. off-brand color + font ----
    const OFF = { kind: 'design', html: '<div class="x">Off brand text here</div>', css: '.x{position:absolute;left:96px;top:200px;font-family:"Comic Sans MS",cursive;font-size:64px;color:#ff00aa}' };
    const pf = await preview(A, OFF);
    const w = warningsOf(pf);
    check('preview off-brand: no errors', pf.ok && errorsOf(pf).length === 0, pf.text.slice(0, 300));
    check('preview off-brand: color warning', w.some(x => /colou?r/i.test(x)), w.join(' | ') || pf.text.slice(0, 200));
    check('preview off-brand: font warning', w.some(x => /font/i.test(x)), w.join(' | ') || pf.text.slice(0, 200));

    // ---- assets ----
    const png = tinyPng();
    const up = await call(A, 'upload_asset', { name: `smoke-${RUN}.png`, mimeType: 'image/png', base64: png.toString('base64') });
    if (up.data?.id) assetIds.add(up.data.id);
    check('upload_asset: valid PNG accepted with width/height', up.ok && up.data?.width === 3 && up.data?.height === 2 && /^https?:/.test(up.data?.url ?? ''), up.text.slice(0, 200));
    const fake = await call(A, 'upload_asset', { name: `smoke-fake-${RUN}.png`, mimeType: 'image/png', base64: Buffer.from('this is definitely not a png at all').toString('base64') });
    if (fake.data?.id) assetIds.add(fake.data.id);
    check('upload_asset: fake PNG rejected', !fake.ok, fake.text.slice(0, 200));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><script>alert(1)</script><rect width="40" height="40" fill="#0B4A2F" onload="alert(2)"/><image href="${HOST}/svg-ext"/></svg>`;
    const sv = await call(A, 'upload_asset', { name: `smoke-${RUN}.svg`, mimeType: 'image/svg+xml', base64: Buffer.from(svg).toString('base64') });
    if (sv.data?.id) assetIds.add(sv.data.id);
    check('upload_asset: SVG accepted', sv.ok && /^https?:/.test(sv.data?.url ?? ''), sv.text.slice(0, 200));
    if (sv.data?.url) {
      const body = await (await fetch(sv.data.url)).text();
      check('upload_asset: SVG comes back sanitized', body.includes('<svg') && !/<script/i.test(body) && !/onload/i.test(body) && !body.includes(HOST), body.slice(0, 200));
    } else check('upload_asset: SVG comes back sanitized', false, 'no url');
    const la = await call(A, 'list_assets');
    check('list_assets lists the upload', la.ok && JSON.stringify(la.data ?? []).includes(up.data?.id ?? 'none'), la.text.slice(0, 200));

    const ASSET = { kind: 'design', name: 'with asset', html: `<div class="a"><img src="${up.data?.url}" width="300" height="200" alt="asset"><h2>Asset slide</h2></div>`, css: '.a{position:absolute;left:96px;top:200px}h2{font-size:56px;color:var(--ink)}' };
    const pa = await preview(A, ASSET);
    const blockedWarn = warningsOf(pa).filter(x => /block|broken|fail|load/i.test(x) && /image|img|asset/i.test(x));
    check('preview with uploaded asset: no errors', pa.ok && errorsOf(pa).length === 0, pa.text.slice(0, 300));
    check('preview with uploaded asset: no blocked-image warning', pa.ok && blockedWarn.length === 0, blockedWarn.join(' | '));

    // ---- 4. hostile slide ----
    const HOSTILE = {
      kind: 'design', name: 'hostile',
      html: `<div class="h"><h2>Hostile</h2>
<script>fetch('${HOST}/s')</script>
<img src="${HOST}/a" onerror="fetch('${HOST}/onerror')">
<iframe src="${HOST}/b"></iframe>
<link rel="stylesheet" href="${HOST}/c">
<object data="${HOST}/o"></object><embed src="${HOST}/emb">
<div style="width:50px;height:50px;background:url(${HOST}/inline)">x</div></div>`,
      css: `.h{position:absolute;left:96px;top:200px;font-size:48px;color:var(--ink);background:url(${HOST}/d)}\n@import "${HOST}/e";\n.h h2{background-image:url("${HOST}/f")}`,
    };
    const ph = await preview(A, HOSTILE);
    check('preview hostile slide: does not crash', ph.ok, ph.text.slice(0, 300));
    await new Promise(r => setTimeout(r, 800));
    check('hostile preview: catcher received zero requests', hits.length === 0, hits.join(', '));

    // ---- mixed carousel (templates + design), rendered ONCE, includes hostile + asset slides ----
    const mixed = await call(A, 'create_carousel', {
      title: `smoke design mixed ${RUN}`, tipNumber: 1,
      slides: [
        { kind: 'cover', hook: 'Smoke *mixed* carousel' },
        { kind: 'content', title: 'Template *slide*', points: ['one', 'two'] },
        VALID, ASSET, HOSTILE,
        { kind: 'code', file: 'a.ts', code: 'const a = 1;' },
        { kind: 'cta', hook: 'Save this for *later*.' },
      ],
      render: true,
    });
    const mid: string | undefined = mixed.data?.id;
    if (mid) carouselIds.add(mid);
    check('create mixed carousel (templates + design) with render', mixed.ok && !!mid && (mixed.data?.images?.length ?? mixed.data?.slides ?? 7) !== 0, mixed.text.slice(0, 300));
    await new Promise(r => setTimeout(r, 800));
    check('hostile saved render: catcher received zero requests (preview + render)', hits.length === 0, hits.join(', '));
    if (mid) {
      const gc = await call(A, 'get_carousel', { id: mid });
      const kinds: string[] = (gc.data?.slides ?? gc.data?.version?.slides ?? []).map((s: any) => s.kind);
      check('mixed carousel keeps template and design kinds', gc.ok && kinds.includes('cover') && kinds.includes('design') && kinds.includes('code'), kinds.join(',') || gc.text.slice(0, 200));
      const vs = await call(A, 'view_slides', { id: mid, slides: [3] });
      check('view_slides on a design slide returns an image', vs.ok && vs.images === 1, vs.text.slice(0, 200));
    }

    // ---- get_slide_source round trip ----
    const rt = await call(A, 'create_carousel', { title: `smoke design source ${RUN}`, slides: [{ kind: 'cover', hook: 'Smoke *source* cover' }, { kind: 'content', title: 'Source *title*', points: ['a', 'b', 'c'] }, { kind: 'cta', hook: 'Save *it*' }], render: false });
    const rid: string | undefined = rt.data?.id;
    if (rid) carouselIds.add(rid);
    check('create template carousel for round trip', rt.ok && !!rid, rt.text.slice(0, 200));
    if (rid) {
      const src = await call(A, 'get_slide_source', { id: rid, slide: 2 });
      const design = [src.data?.design, src.data?.slide, src.data].find(d => d?.kind === 'design') ?? null;
      check('get_slide_source: template slide comes back as design source', src.ok && !!design && typeof design.html === 'string' && design.html.length > 0, src.text.slice(0, 300));
      if (design) {
        const pr = await preview(A, design, { carouselId: rid, n: 2, total: 3 });
        check('get_slide_source -> preview has no errors', pr.ok && pr.data !== null && errorsOf(pr).length === 0, pr.text.slice(0, 300));
      } else check('get_slide_source -> preview has no errors', false, 'no design slide returned');
    }

    // ---- layouts ----
    const lname = `smoke-layout-${RUN}`;
    layoutNames.add(lname);
    const sl = await call(A, 'save_layout', {
      name: lname, description: 'smoke layout',
      html: '<div class="L"><h2>{{title}}</h2><p>{{body}}</p></div>',
      css: '.L{position:absolute;left:96px;top:200px;right:96px}.L h2{font-size:72px;color:var(--ink);margin:0 0 24px}.L p{font-size:36px;color:var(--ink);margin:0}',
    });
    check('save_layout', sl.ok && arr(sl.data?.placeholders).includes('title') && arr(sl.data?.placeholders).includes('body'), sl.text.slice(0, 300));
    const ll = await call(A, 'list_layouts');
    check('list_layouts includes it', ll.ok && Array.isArray(ll.data) && ll.data.some((l: any) => l.name === lname), ll.text.slice(0, 200));
    const evil = '<img src=x onerror=alert(1)> and *marked*';
    const lc = await call(A, 'create_carousel', {
      title: `smoke design layout ${RUN}`,
      slides: [{ kind: 'cover', hook: 'Smoke *layout* cover' }, { kind: 'design', layout: lname, fill: { title: 'Plain *title*', body: evil } }, { kind: 'cta', hook: 'Save *it*' }],
      render: false,
    });
    const lid: string | undefined = lc.data?.id;
    if (lid) carouselIds.add(lid);
    check('create slide from { kind: design, layout, fill }', lc.ok && !!lid, lc.text.slice(0, 300));
    if (lid) {
      const g = await call(A, 'get_carousel', { id: lid });
      const slides: any[] = g.data?.slides ?? g.data?.version?.slides ?? [];
      const d = slides[1];
      check('layout slide became a design slide with filled html', g.ok && d?.kind === 'design' && /Plain/.test(d.html ?? ''), JSON.stringify(d ?? g.text.slice(0, 200)).slice(0, 300));
      check('layout fill is escaped (no live <img onerror>)', !!d && !/<img[^>]*onerror/i.test(d.html ?? '') && /&lt;img/.test(d.html ?? ''), (d?.html ?? '').slice(0, 300));
    }
    const dl = await call(A, 'delete_layout', { name: lname });
    check('delete_layout', dl.ok, dl.text.slice(0, 200));
    if (dl.ok) layoutNames.delete(lname);
    const ll2 = await call(A, 'list_layouts');
    check('deleted layout is gone from list_layouts', ll2.ok && !ll2.data?.some?.((l: any) => l.name === lname), ll2.text.slice(0, 200));

    // ---- final catcher check across everything ----
    await new Promise(r => setTimeout(r, 500));
    check('request catcher: zero requests over the whole run', hits.length === 0, hits.join(', '));

    // ---- template snapshot check ----
    const rc = spawnSync('npx tsx scripts/render-check.ts --check', { shell: true, encoding: 'utf8', timeout: 240_000 });
    check('render-check --check passes', rc.status === 0, `${rc.stdout?.slice(-200) ?? ''} ${rc.stderr?.slice(-200) ?? ''}`);
  } catch (err) {
    check('script error', false, err instanceof Error ? err.message : String(err));
  } finally {
    catcher.close();
    const admin = await makeKey('cleanup').catch(() => null);
    // carousels: soft delete + purge through MCP (also removes Blob images), DB fallback
    for (const id of carouselIds) {
      try {
        if (admin) { await call(admin, 'delete_carousel', { id }); const p = await call(admin, 'purge_carousel', { id }); if (p.ok) continue; }
        if (process.env.BLOB_READ_WRITE_TOKEN) {
          const page = await list({ prefix: `carousels/${id}/` });
          if (page.blobs.length) await del(page.blobs.map(b => b.url));
        }
        await db.delete(schema.requests).where(eq(schema.requests.carouselId, id));
        await db.delete(schema.carousels).where(eq(schema.carousels.id, id));
      } catch (err) { check(`cleanup: carousel ${id}`, false, String(err)); }
    }
    for (const id of assetIds) { try { if (admin) await call(admin, 'delete_asset', { id }); } catch (err) { check(`cleanup: asset ${id}`, false, String(err)); } }
    for (const name of layoutNames) { try { if (admin) await call(admin, 'delete_layout', { name }); } catch (err) { check(`cleanup: layout ${name}`, false, String(err)); } }
    try { if (previewUrls.size && process.env.BLOB_READ_WRITE_TOKEN) await del([...previewUrls]); } catch (err) { check('cleanup: preview blobs', false, String(err)); }
    try {
      // leftovers if MCP cleanup failed
      await db.delete(schema.layouts).where(like(schema.layouts.name, `smoke-layout-${RUN}`));
      if (assetIds.size) await db.delete(schema.assets).where(inArray(schema.assets.id, [...assetIds]));
      if (keyNames.length) await db.delete(schema.activity).where(inArray(schema.activity.actor, keyNames));
      await db.delete(schema.apiKeys).where(like(schema.apiKeys.name, `smoke-%-${RUN}`));
    } catch (err) { check('cleanup: rows and keys', false, String(err)); }
  }

  const wd = Math.max(...rows.map(r => r.name.length));
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(wd)}${r.ok ? '' : `  ${r.detail.replace(/\s+/g, ' ').slice(0, 200)}`}`);
  const failed = rows.filter(r => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ''}  (${ENDPOINT})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
