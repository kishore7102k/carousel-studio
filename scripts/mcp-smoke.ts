/* eslint-disable @typescript-eslint/no-explicit-any -- tool results are untyped JSON */
// MCP smoke test: calls every tool over HTTP and asserts the results.
//   npm run mcp:smoke            (against STUDIO_URL, default http://localhost:3000)
// Creates temporary API keys, carousels and requests directly in the DB, and removes them all in `finally`.
// The brand row is snapshotted first and restored exactly afterwards (live brand may hold licensed fonts).
import { and, eq, inArray, like } from 'drizzle-orm';
import { list, del } from '@vercel/blob';
import { getDb, schema } from '@/db';
import { newApiKey, sha256 } from '@/lib/auth';

const BASE = (process.env.STUDIO_URL?.replace(/\/+$/, '') || 'http://localhost:3000');
const ENDPOINT = `${BASE}/api/mcp`;
const RUN = Math.random().toString(36).slice(2, 8);

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];
function check(name: string, ok: boolean, detail = '') {
  rows.push({ name, ok, detail: ok ? '' : detail });
}

// ---------- MCP over HTTP ----------

type Rpc = { result?: { content?: { type: string; text?: string }[]; isError?: boolean; [k: string]: unknown }; error?: { code: number; message: string } };

async function rpc(key: string, method: string, params?: unknown): Promise<Rpc> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }),
  });
  const txt = await res.text();
  const data = txt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
  const raw = data.length ? data[data.length - 1] : txt;
  try { return JSON.parse(raw) as Rpc; } catch { return { error: { code: res.status, message: raw.slice(0, 300) } }; }
}

type Call = { ok: boolean; text: string; data: any; images: number };
async function call(key: string, tool: string, args: Record<string, unknown> = {}): Promise<Call> {
  const r = await rpc(key, 'tools/call', { name: tool, arguments: args });
  if (r.error) return { ok: false, text: r.error.message ?? JSON.stringify(r.error), data: null, images: 0 };
  const content = r.result?.content ?? [];
  const text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* plain text */ }
  return { ok: !r.result?.isError, text, data, images: content.filter(c => c.type === 'image').length };
}

// ---------- state for cleanup ----------

const keyNames: string[] = [];
const keyIds: string[] = [];
const carouselIds = new Set<string>();
const requestIds = new Set<string>();

async function makeKey(label: string, scopes: string[]) {
  const name = `smoke-${label}-${RUN}`;
  const key = newApiKey();
  const [row] = await getDb().insert(schema.apiKeys).values({ name, hash: await sha256(key), scopes }).returning({ id: schema.apiKeys.id });
  keyNames.push(name);
  keyIds.push(row.id);
  return { name, key, id: row.id };
}

// Templates were removed: every slide is a design slide.
const S = {
  cover: { kind: 'design', name: 'cover', html: '<h1 class="t-hook">Smoke <mark>test</mark> hook</h1>' },
  content: { kind: 'design', name: 'content', html: '<h2 class="t-title">Smoke <mark>title</mark></h2><ul class="rows"><li>one</li><li>two</li></ul>' },
  code: { kind: 'design', name: 'code', html: '<pre class="editor">const a = 1;</pre>' },
  cta: { kind: 'design', name: 'cta', html: '<h1 class="t-hook">Save this for <mark>later</mark>.</h1>' },
};
const SLIDES = [S.cover, S.content, S.code, S.cta];

const BASE64_RUN = /[A-Za-z0-9+/]{200,}={0,2}/;

async function main() {
  const db = getDb();

  // ---- brand snapshot FIRST, before anything can touch it ----
  const [brandSnapshot] = await db.select().from(schema.brand).where(eq(schema.brand.id, 'default'));
  let brandTouched = false;

  try {
    const admin = await makeKey('admin', ['read', 'write', 'admin']);
    const reader = await makeKey('read', ['read']);
    const writer = await makeKey('write', ['read', 'write']);
    const writer2 = await makeKey('write2', ['read', 'write']);
    const A = admin.key;

    // ---- protocol ----
    const init = await rpc(A, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
    check('initialize', !!init.result && !init.error, JSON.stringify(init.error));

    const tl = await rpc(A, 'tools/list');
    const tools = ((tl.result as { tools?: { name: string; annotations?: Record<string, unknown> }[] })?.tools ?? []);
    const names = new Set(tools.map(t => t.name));
    const EXPECTED = ['get_brand_guide', 'list_carousels', 'get_carousel', 'create_carousel', 'update_carousel', 'duplicate_carousel', 'delete_carousel', 'restore_carousel', 'purge_carousel', 'set_current_version', 'compare_versions', 'update_slides', 'edit_slide', 'insert_slide', 'remove_slide', 'move_slide', 'render_carousel', 'view_slides', 'get_download_links', 'list_requests', 'get_request', 'add_note', 'request_carousel', 'claim_request', 'complete_request', 'dismiss_request', 'reopen_request', 'get_brand', 'update_brand', 'import_brand', 'reset_brand', 'list_activity', 'list_connections', 'create_key', 'revoke_access', 'search', 'fetch', 'set_carousel_status'];
    const missing = EXPECTED.filter(n => !names.has(n));
    check('tools/list has every tool', missing.length === 0, `missing: ${missing.join(', ')}`);
    check('tools/list: all annotated openWorldHint=false', tools.length > 0 && tools.every(t => t.annotations?.openWorldHint === false), tools.filter(t => t.annotations?.openWorldHint !== false).map(t => t.name).join(', '));

    // ---- guide, resource, prompts ----
    const guide = await call(A, 'get_brand_guide');
    check('get_brand_guide', guide.ok && guide.text.length > 200, guide.text.slice(0, 120));
    const res = await rpc(A, 'resources/read', { uri: 'studio://brand-guide' });
    const resText = (res.result as { contents?: { text?: string }[] })?.contents?.[0]?.text ?? '';
    check('resources/read studio://brand-guide', resText.length > 200, JSON.stringify(res.error ?? res.result).slice(0, 120));
    const p1 = await rpc(A, 'prompts/get', { name: 'make_carousel', arguments: { topic: 'smoke topic' } });
    check('prompts/get make_carousel', JSON.stringify(p1.result ?? '').includes('smoke topic'), JSON.stringify(p1.error ?? p1.result).slice(0, 120));
    const p2 = await rpc(A, 'prompts/get', { name: 'handle_requests' });
    check('prompts/get handle_requests', ((p2.result as { messages?: unknown[] })?.messages?.length ?? 0) > 0, JSON.stringify(p2.error ?? p2.result).slice(0, 120));

    // ---- scopes ----
    const rw = await call(reader.key, 'create_carousel', { title: 'nope', slides: SLIDES, render: false });
    check('read key: write tool -> missing scope', !rw.ok && /missing scope/.test(rw.text), rw.text);
    const wa = await call(writer.key, 'list_connections');
    check('write key: admin tool -> missing scope', !wa.ok && /missing scope/.test(wa.text), wa.text);
    const ra = await call(reader.key, 'list_carousels', { limit: 1 });
    check('read key: read tool allowed', ra.ok, ra.text);

    // ---- carousels ----
    const title = `smoke carousel ${RUN}`;
    const cr = await call(writer.key, 'create_carousel', { title, slides: SLIDES, render: false, note: 'smoke' });
    const cid: string | undefined = cr.data?.id;
    if (cid) carouselIds.add(cid);
    check('create_carousel', cr.ok && !!cid && cr.data.version === 1 && typeof cr.data.url === 'string', cr.text);
    if (!cid) throw new Error('cannot continue without a carousel');

    const lc = await call(A, 'list_carousels', { query: `smoke carousel ${RUN}` });
    check('list_carousels query', lc.ok && Array.isArray(lc.data) && lc.data.some((c: any) => c.id === cid), lc.text.slice(0, 200));
    const gc = await call(A, 'get_carousel', { id: cid });
    check('get_carousel (url, 1-based n)', gc.ok && !!gc.data?.url && gc.data.version?.slides?.[0]?.n === 1 && gc.data.version?.slides?.[3]?.n === 4, gc.text.slice(0, 300));

    const uc = await call(writer.key, 'update_carousel', { id: cid, title: `${title} v2`, number: 77, status: 'review' });
    check('update_carousel', uc.ok && JSON.stringify(uc.data).includes('v2'), uc.text);
    const ss = await call(writer.key, 'set_carousel_status', { id: cid, status: 'draft' });
    check('set_carousel_status (deprecated alias)', ss.ok, ss.text);

    // ---- slides / versions ----
    const us = await call(writer.key, 'update_slides', { id: cid, slides: [...SLIDES.slice(0, 3), { kind: 'design', name: 'cta', html: '<h1 class="t-hook">Edited <mark>cta</mark></h1>' }], render: false, note: 'v2' });
    check('update_slides -> v2', us.ok && us.data?.version === 2, us.text);
    const stale = await call(writer.key, 'update_slides', { id: cid, slides: SLIDES, baseVersion: 1, render: false });
    check('update_slides baseVersion mismatch -> stale', !stale.ok && /stale/.test(stale.text), stale.text);
    const okBase = await call(writer.key, 'update_slides', { id: cid, slides: SLIDES, baseVersion: 2, render: false, note: 'v3' });
    check('update_slides baseVersion match -> v3', okBase.ok && okBase.data?.version === 3, okBase.text);
    const es = await call(writer.key, 'edit_slide', { id: cid, slide: 2, patch: { html: '<h2 class="t-title">Edited <mark>title</mark></h2>' }, render: false, baseVersion: 3 });
    check('edit_slide -> v4', es.ok && es.data?.version === 4, es.text);
    const esStale = await call(writer.key, 'edit_slide', { id: cid, slide: 2, patch: { html: '<p class="t-body">x</p>' }, render: false, baseVersion: 3 });
    check('edit_slide stale', !esStale.ok && /stale/.test(esStale.text), esStale.text);
    const ins = await call(writer.key, 'insert_slide', { id: cid, at: 5, slide: { kind: 'design', name: 'inserted', html: '<h2 class="t-title">Inserted <mark>one</mark></h2>' }, render: false });
    check('insert_slide (append) -> v5', ins.ok && ins.data?.version === 5, ins.text);
    const mv = await call(writer.key, 'move_slide', { id: cid, from: 5, to: 2, render: false });
    check('move_slide -> v6', mv.ok && mv.data?.version === 6, mv.text);
    const rm = await call(writer.key, 'remove_slide', { id: cid, slide: 2, render: false });
    check('remove_slide -> v7', rm.ok && rm.data?.version === 7, rm.text);
    const tpl = await call(writer.key, 'insert_slide', { id: cid, at: 2, slide: { kind: 'content', title: 'Template', points: ['x'] }, render: false });
    check('template slides are rejected (removed)', !tpl.ok && /were removed/.test(tpl.text), tpl.text.slice(0, 200));
    const tplC = await call(writer.key, 'create_carousel', { title: 'smoke template rejected', slides: [{ kind: 'cover', hook: 'x' }, { kind: 'cta', hook: 'y' }], render: false });
    if (tplC.data?.id) carouselIds.add(tplC.data.id);
    check('create_carousel rejects template slides', !tplC.ok && /were removed/.test(tplC.text), tplC.text.slice(0, 200));
    const cmp = await call(A, 'compare_versions', { id: cid, a: 3, b: 4 });
    check('compare_versions', cmp.ok && JSON.stringify(cmp.data).includes('changed'), cmp.text.slice(0, 300));
    const scv = await call(writer.key, 'set_current_version', { id: cid, version: 4 });
    check('set_current_version', scv.ok, scv.text);
    const gc2 = await call(A, 'get_carousel', { id: cid });
    check('current version is 4 after rollback', gc2.ok && gc2.data?.carousel?.currentVersion === 4, gc2.text.slice(0, 200));
    const noVer = await call(writer.key, 'set_current_version', { id: cid, version: 999 });
    check('set_current_version unknown version refused', !noVer.ok, noVer.text);

    const dup = await call(writer.key, 'duplicate_carousel', { id: cid, title: `${title} copy`, render: false });
    const did: string | undefined = dup.data?.id;
    if (did) carouselIds.add(did);
    check('duplicate_carousel', dup.ok && !!did && did !== cid && dup.data.version === 1, dup.text);

    // ---- render (the only render in the run) ----
    const rc = await call(writer.key, 'create_carousel', { title: `smoke render ${RUN}`, slides: SLIDES.slice(0, 2).concat([S.cta]), render: false });
    const rid: string | undefined = rc.data?.id;
    if (rid) carouselIds.add(rid);
    if (rid) {
      const vs0 = await call(reader.key, 'view_slides', { id: rid });
      check('view_slides before render -> clear error', !vs0.ok, vs0.text);
      const rend = await call(writer.key, 'render_carousel', { id: rid });
      check('render_carousel', rend.ok && (rend.data?.images?.length ?? 0) === 3, rend.text.slice(0, 300));
      const vs = await call(reader.key, 'view_slides', { id: rid, slides: [1] });
      check('view_slides (image + URL text)', vs.ok && vs.images === 1 && /https?:\/\//.test(vs.text), vs.text.slice(0, 200));
      const dl = await call(reader.key, 'get_download_links', { id: rid });
      check('get_download_links', dl.ok && /01\.png/.test(dl.text) && /03\.png/.test(dl.text) && /https?:\/\//.test(dl.text), dl.text.slice(0, 300));
    } else check('render carousel created', false, rc.text);

    // ---- requests ----
    const note = await call(writer.key, 'add_note', { carouselId: cid, slide: 1, text: 'smoke note', x: 0.2, y: 0.3 });
    const nid: string | undefined = note.data?.id;
    if (nid) requestIds.add(nid);
    check('add_note', note.ok && !!nid && note.data.slide === 1, note.text);
    const badNote = await call(writer.key, 'add_note', { carouselId: cid, slide: 99, text: 'x' });
    check('add_note beyond last slide refused', !badNote.ok, badNote.text);
    const rq = await call(writer.key, 'request_carousel', { prompt: `smoke prompt ${RUN}` });
    const qid: string | undefined = rq.data?.id;
    if (qid) requestIds.add(qid);
    check('request_carousel', rq.ok && !!qid && rq.data.kind === 'new', rq.text);
    const lr = await call(reader.key, 'list_requests', { carouselId: cid });
    check('list_requests', lr.ok && Array.isArray(lr.data) && lr.data.some((r: any) => r.id === nid), lr.text.slice(0, 200));
    const gr = await call(reader.key, 'get_request', { id: nid ?? '' });
    check('get_request', gr.ok && JSON.stringify(gr.data).includes('smoke note'), gr.text.slice(0, 200));

    if (nid) {
      const [c1, c2] = await Promise.all([call(writer.key, 'claim_request', { id: nid }), call(writer2.key, 'claim_request', { id: nid })]);
      check('two agents cannot both claim one request', Number(c1.ok) + Number(c2.ok) === 1, `${c1.ok}/${c2.ok}`);
      const winner = c1.ok ? writer : writer2;
      const comp = await call(winner.key, 'complete_request', { id: nid, reply: 'smoke done', resultVersion: 4 });
      check('complete_request', comp.ok && comp.data?.status === 'done', comp.text);
      const reo = await call(writer.key, 'reopen_request', { id: nid });
      check('reopen_request', reo.ok && reo.data?.status === 'open', reo.text);
      const dis = await call(writer.key, 'dismiss_request', { id: nid });
      check('dismiss_request', dis.ok && dis.data?.status === 'dismissed', dis.text);
    }
    if (qid) {
      const dq = await call(writer.key, 'dismiss_request', { id: qid });
      check('dismiss_request (new prompt)', dq.ok, dq.text);
    }

    // ---- search / fetch ----
    const se = await call(reader.key, 'search', { query: `smoke carousel ${RUN}` });
    const hit = se.data?.results?.find((r: any) => r.id === `carousel:${cid}`);
    check('search finds carousel', se.ok && !!hit && typeof hit.url === 'string', se.text.slice(0, 300));
    const fe = await call(reader.key, 'fetch', { id: `carousel:${cid}` });
    check('fetch carousel', fe.ok && !!fe.data?.text && !!fe.data?.url && fe.data?.id === `carousel:${cid}`, fe.text.slice(0, 300));
    if (nid) {
      const fr = await call(reader.key, 'fetch', { id: `request:${nid}` });
      check('fetch request', fr.ok && /smoke note/.test(fr.text), fr.text.slice(0, 200));
    }

    // ---- trash lifecycle ----
    const target = did ?? cid;
    const pOut = await call(A, 'purge_carousel', { id: target });
    check('purge outside trash refused', !pOut.ok && /trash/i.test(pOut.text), pOut.text);
    const t1 = await call(writer.key, 'delete_carousel', { id: target });
    check('delete_carousel (soft)', t1.ok, t1.text);
    const hidden = await call(A, 'list_carousels', { query: `smoke carousel ${RUN}` });
    check('trashed carousel hidden from list_carousels', hidden.ok && !hidden.data?.some((c: any) => c.id === target), hidden.text.slice(0, 200));
    const shown = await call(A, 'list_carousels', { query: `smoke carousel ${RUN}`, includeTrashed: true });
    check('includeTrashed shows it', shown.ok && shown.data?.some((c: any) => c.id === target), shown.text.slice(0, 200));
    const purgeW = await call(writer.key, 'purge_carousel', { id: target });
    check('write key cannot purge (missing scope)', !purgeW.ok && /missing scope/.test(purgeW.text), purgeW.text);
    const rs = await call(writer.key, 'restore_carousel', { id: target });
    check('restore_carousel', rs.ok, rs.text);
    const back = await call(A, 'list_carousels', { query: `smoke carousel ${RUN}` });
    check('restored carousel back in list', back.ok && back.data?.some((c: any) => c.id === target), back.text.slice(0, 200));
    await call(writer.key, 'delete_carousel', { id: target });
    const pg = await call(A, 'purge_carousel', { id: target });
    check('purge from trash', pg.ok, pg.text);
    carouselIds.delete(target);
    const gone = await call(A, 'get_carousel', { id: target });
    check('purged carousel is gone', !gone.ok, gone.text.slice(0, 120));

    // rendered carousel: purge deletes its Blob images
    if (rid) {
      const before = process.env.BLOB_READ_WRITE_TOKEN ? (await list({ prefix: `carousels/${rid}/` })).blobs.length : -1;
      await call(writer.key, 'delete_carousel', { id: rid });
      const pr = await call(A, 'purge_carousel', { id: rid });
      carouselIds.delete(rid);
      check('purge rendered carousel', pr.ok, pr.text);
      if (before >= 0) {
        const after = (await list({ prefix: `carousels/${rid}/` })).blobs.length;
        check(`purge deleted Blob images (${before} -> ${after})`, before > 0 && after === 0, `${before} -> ${after}`);
      }
    }

    // ---- brand (snapshot taken above; restored in finally) ----
    brandTouched = true;
    const gb = await call(reader.key, 'get_brand');
    check('get_brand', gb.ok && !!gb.data?.name, gb.text.slice(0, 200));
    check('get_brand has no base64', gb.ok && !BASE64_RUN.test(gb.text) && !JSON.stringify(gb.data).includes('"data"') && !JSON.stringify(gb.data).includes('"base64"'), `len ${gb.text.length}`);
    const origName: string = gb.data?.name ?? 'Studio';
    const ub = await call(A, 'update_brand', { name: `Smoke ${RUN}`, labelPrefix: 'Smk' });
    check('update_brand', ub.ok, ub.text);
    const gb2 = await call(A, 'get_brand');
    check('update_brand visible in get_brand', gb2.ok && gb2.data?.name === `Smoke ${RUN}` && gb2.data?.labelPrefix === 'Smk', gb2.text.slice(0, 200));
    const ubBad = await call(A, 'update_brand', { roles: { notARole: 'x' } });
    check('update_brand rejects unknown role', !ubBad.ok, ubBad.text);
    const ubW = await call(writer.key, 'update_brand', { name: 'x' });
    check('write key cannot update_brand', !ubW.ok && /missing scope/.test(ubW.text), ubW.text);

    const tokens = { name: `Smoke tokens ${RUN}`, color: { themes: [{ id: 'light' }], tokens: [{ name: 'smoke-a', value: '#112233' }, { name: 'smoke-b', value: '#445566' }] } };
    const woff2 = Buffer.concat([Buffer.from('wOF2', 'latin1'), Buffer.alloc(32)]).toString('base64');
    const impOk = await call(A, 'import_brand', { tokens, readme: '# smoke', fonts: [{ family: 'SmokeFont', weight: '400', base64: woff2 }] });
    check('import_brand tokens + woff2 font', impOk.ok, impOk.text);
    const gb3 = await call(A, 'get_brand');
    check('imported font listed without data', gb3.ok && JSON.stringify(gb3.data).includes('SmokeFont') && !BASE64_RUN.test(gb3.text), gb3.text.slice(0, 200));
    const badFont = Buffer.concat([Buffer.from('NOPE', 'latin1'), Buffer.alloc(32)]).toString('base64');
    const impBad = await call(A, 'import_brand', { tokens, fonts: [{ family: 'Bad', weight: '400', base64: badFont }] });
    check('import_brand rejects bad magic bytes', !impBad.ok && /magic|woff/i.test(impBad.text), impBad.text);
    const impNoColor = await call(A, 'import_brand', { tokens: { name: 'x' } });
    check('import_brand rejects tokens without colors', !impNoColor.ok, impNoColor.text);
    const rb = await call(A, 'reset_brand');
    check('reset_brand', rb.ok, rb.text);
    void origName;

    // ---- access + activity ----
    const lcn = await call(A, 'list_connections');
    const mine = lcn.data?.apiKeys?.find?.((k: any) => k.id === admin.id);
    check('list_connections (no hashes, current flagged)', lcn.ok && !!mine && mine.current === true && !/hash/i.test(lcn.text), lcn.text.slice(0, 200));
    const ck = await call(A, 'create_key', { name: `smoke-made-${RUN}`, scopes: ['read'] });
    if (ck.data?.id) { keyIds.push(ck.data.id); keyNames.push(ck.data.name); }
    check('create_key returns secret once', ck.ok && typeof ck.data?.key === 'string' && ck.data.key.startsWith('ks_') && JSON.stringify(ck.data.scopes) === '["read"]', ck.text.slice(0, 200));
    if (ck.data?.key) {
      const used = await call(ck.data.key, 'list_carousels', { limit: 1 });
      check('newly created key works', used.ok, used.text);
    }
    const self = await call(A, 'revoke_access', { id: admin.id });
    check('revoke_access refuses own key', !self.ok, self.text);
    if (ck.data?.id) {
      const rv = await call(A, 'revoke_access', { id: ck.data.id });
      check('revoke_access', rv.ok, rv.text);
      const after = await call(ck.data.key, 'list_carousels', { limit: 1 });
      check('revoked key no longer works', !after.ok, (after.text ?? '').slice(0, 100));
    }
    const act = await call(reader.key, 'list_activity', { carouselId: cid, limit: 50 });
    const actions = new Set((act.data ?? []).map((a: any) => a.action));
    check('list_activity records writes for carousel', act.ok && actions.has('create_carousel') && actions.has('update_slides'), [...actions].join(','));
    check('activity detail has no base64', act.ok && !BASE64_RUN.test(act.text), '');
  } catch (err) {
    check('script error', false, err instanceof Error ? err.message : String(err));
  } finally {
    // ---- restore brand first: nothing may render between brand writes and here ----
    try {
      if (brandSnapshot) {
        await db.insert(schema.brand).values({ id: 'default', pack: brandSnapshot.pack, updatedAt: brandSnapshot.updatedAt })
          .onConflictDoUpdate({ target: schema.brand.id, set: { pack: brandSnapshot.pack, updatedAt: brandSnapshot.updatedAt } });
      } else {
        await db.delete(schema.brand).where(eq(schema.brand.id, 'default'));
      }
    } catch (err) { check('cleanup: restore brand row', false, String(err)); }
    // make the running server drop its 30s brand cache (needs an admin key; keys are deleted below)
    try {
      if (brandTouched) {
        {
          const tmp = await makeKey('bust', ['read', 'write', 'admin']);
          if (brandSnapshot) {
            const pack = brandSnapshot.pack as { name?: string };
            const r = await call(tmp.key, 'update_brand', { name: pack.name ?? 'Studio' });
            check('cleanup: brand cache dropped (update_brand identity)', r.ok, r.text);
            const [now] = await db.select().from(schema.brand).where(eq(schema.brand.id, 'default'));
            check('cleanup: brand row identical to snapshot', JSON.stringify(now?.pack) === JSON.stringify(brandSnapshot.pack) || deepEqual(now?.pack, brandSnapshot.pack), 'pack differs after restore');
          } else {
            const r = await call(tmp.key, 'reset_brand');
            check('cleanup: brand cache dropped (reset_brand)', r.ok, r.text);
          }
        }
      }
    } catch (err) { check('cleanup: brand cache bust', false, String(err)); }

    // ---- carousels still left (failure paths): direct DB delete + Blob sweep ----
    for (const id of carouselIds) {
      try {
        if (process.env.BLOB_READ_WRITE_TOKEN) {
          const page = await list({ prefix: `carousels/${id}/` });
          if (page.blobs.length) await del(page.blobs.map(b => b.url));
        }
        await db.delete(schema.requests).where(eq(schema.requests.carouselId, id));
        await db.delete(schema.carousels).where(eq(schema.carousels.id, id));
      } catch (err) { check(`cleanup: carousel ${id}`, false, String(err)); }
    }
    try {
      if (requestIds.size) await db.delete(schema.requests).where(inArray(schema.requests.id, [...requestIds]));
      await db.delete(schema.requests).where(and(eq(schema.requests.kind, 'new'), like(schema.requests.text, `smoke prompt ${RUN}%`)));
      if (keyNames.length) await db.delete(schema.activity).where(inArray(schema.activity.actor, keyNames));
      await db.delete(schema.apiKeys).where(like(schema.apiKeys.name, `smoke-%-${RUN}`));
    } catch (err) { check('cleanup: rows and keys', false, String(err)); }
  }

  // ---- report ----
  const w = Math.max(...rows.map(r => r.name.length));
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}${r.ok ? '' : `  ${r.detail.replace(/\s+/g, ' ').slice(0, 200)}`}`);
  const failed = rows.filter(r => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ''}  (${ENDPOINT})`);
  process.exit(failed ? 1 : 0);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

main().catch(err => { console.error(err); process.exit(1); });
