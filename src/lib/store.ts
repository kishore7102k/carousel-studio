import { and, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { del, list } from '@vercel/blob';
import { getDb, schema } from '@/db';
import { renderPages, renderSlides, uploadPngs, type Lint } from '@/lib/render/render';
import { slideHtml } from '@/lib/render/html';
import { cleanDesignSlide } from '@/lib/render/design';
import type { z } from 'zod';
import { Slide, Slides } from '@/lib/slides';
import { getBrand, tipLabel } from '@/lib/brand';

const { carousels, versions, requests } = schema;
export type Status = (typeof carousels.$inferSelect)['status'];
export type RequestStatus = (typeof requests.$inferSelect)['status'];

const LEASE_MINUTES = 30;

export async function listCarousels(filter: { status?: Status; query?: string; includeTrashed?: boolean; limit?: number } = {}) {
  const db = getDb();
  const { status, query, includeTrashed = false, limit = 50 } = filter;
  const where = and(
    status ? eq(carousels.status, status) : undefined,
    query ? ilike(carousels.title, `%${query}%`) : undefined,
    !includeTrashed ? isNull(carousels.deletedAt) : undefined,
  );
  const rows = await db.select().from(carousels).where(where).orderBy(desc(carousels.updatedAt)).limit(limit);
  if (!rows.length) return [];
  const vs = await db.select({ carouselId: versions.carouselId, number: versions.number, images: versions.images }).from(versions)
    .where(inArray(versions.carouselId, rows.map(r => r.id)));
  const open = await db.select({ carouselId: requests.carouselId, n: sql<number>`count(*)::int` }).from(requests)
    .where(and(inArray(requests.carouselId, rows.map(r => r.id)), inArray(requests.status, ['open', 'claimed']))).groupBy(requests.carouselId);
  return rows.map(r => ({
    ...r,
    cover: vs.find(v => v.carouselId === r.id && v.number === r.currentVersion)?.images[0] ?? null,
    openRequests: open.find(o => o.carouselId === r.id)?.n ?? 0,
  }));
}

export async function getCarousel(id: string, version?: number) {
  const db = getDb();
  const [c] = await db.select().from(carousels).where(eq(carousels.id, id));
  if (!c) return null;
  const all = await db.select({ number: versions.number, createdBy: versions.createdBy, note: versions.note, createdAt: versions.createdAt })
    .from(versions).where(eq(versions.carouselId, id)).orderBy(desc(versions.number));
  const n = version ?? c.currentVersion;
  const [v] = await db.select().from(versions).where(and(eq(versions.carouselId, id), eq(versions.number, n)));
  const reqs = await db.select().from(requests).where(eq(requests.carouselId, id)).orderBy(desc(requests.createdAt));
  return { carousel: c, version: v ?? null, versions: all, requests: reqs };
}

/** Per-slide warnings in tool output: only slides that have some, 1-based. */
export type SlideWarnings = { n: number; warnings: string[] }[];
const slideWarnings = (lint: (Lint | null)[]): SlideWarnings =>
  lint.flatMap((l, i) => (l?.warnings.length ? [{ n: i + 1, warnings: l.warnings }] : []));

/** Validates slides and sanitizes design slides. Returns the clean slides and the sanitizer's notes per slide. */
function prepareSlides(input: unknown): { slides: Slide[]; notes: string[][] } {
  const parsed = Slides.safeParse(input);
  if (!parsed.success) throw new Error(`invalid slides: ${zodMessage(parsed.error)}`);
  const notes: string[][] = [];
  const slides = parsed.data.map((s, i) => {
    if (s.kind !== 'design') { notes.push([]); return s; }
    try {
      const c = cleanDesignSlide(s);
      notes.push(c.warnings);
      return c.slide;
    } catch (err) {
      throw new Error(`slide ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { slides, notes };
}

/**
 * Renders (and lints design slides) BEFORE saving: lint errors (content off the canvas) refuse the save.
 * render false: only design slides are rendered, for lint; no PNGs.
 * Returns the PNGs (null when not rendered) and the per-slide lint, sanitizer notes merged into warnings.
 */
async function renderChecked(slides: Slide[], tip: number | null, notes: string[][], render: boolean) {
  const brand = await getBrand();
  const label = tipLabel(brand, tip);
  let pngs: Buffer[] | null = null;
  let lint: (Lint | null)[] = slides.map(() => null);
  if (render) {
    const r = await renderSlides(slides, label, brand);
    pngs = r.map(x => x.png);
    lint = r.map(x => x.lint);
  } else if (slides.some(s => s.kind === 'design')) {
    const idx = slides.flatMap((s, i) => (s.kind === 'design' ? [i] : []));
    const r = await renderPages(idx.map(i => ({ html: slideHtml(slides[i], i, slides.length, label, brand), lint: true })), brand);
    idx.forEach((i, k) => { lint[i] = r[k].lint; });
  }
  lint = lint.map((l, i) => (l || notes[i]?.length ? { errors: l?.errors ?? [], warnings: [...(notes[i] ?? []), ...(l?.warnings ?? [])] } : null));
  const errors = lint.flatMap((l, i) => (l?.errors.length ? [`slide ${i + 1}: ${l.errors.join('; ')}`] : []));
  if (errors.length) throw new Error(`refused (nothing saved): ${errors.join(' | ')}. Fix and retry; preview_slide checks a slide without saving.`);
  return { pngs, lint };
}

async function saveImages(id: string, number: number, pngs: Buffer[] | null) {
  if (!pngs) return [];
  const images = await uploadPngs(id, number, pngs);
  await getDb().update(versions).set({ images }).where(and(eq(versions.carouselId, id), eq(versions.number, number)));
  return images;
}

export async function createCarousel(input: { title: string; tipNumber?: number | null; slides: Slide[]; createdBy: string; note?: string; render?: boolean }) {
  const { slides, notes } = prepareSlides(input.slides);
  const tip = input.tipNumber ?? null;
  const { pngs, lint } = await renderChecked(slides, tip, notes, input.render !== false);
  const db = getDb();
  const [c] = await db.insert(carousels).values({ title: input.title, tipNumber: tip, status: 'review' }).returning();
  await db.insert(versions).values({ carouselId: c.id, number: 1, slides, lint, createdBy: input.createdBy, note: input.note ?? 'First version' });
  const images = await saveImages(c.id, 1, pngs);
  const warnings = slideWarnings(lint);
  return { id: c.id, version: 1, images, ...(warnings.length ? { warnings } : {}) };
}

/** Readable zod error: "2.title: Invalid input; ..." instead of a JSON dump. */
export function zodMessage(err: z.ZodError) {
  return err.issues.map(i => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`).join('; ');
}

const isUniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
};

/** JSON with sorted object keys: jsonb does not keep key order, so plain JSON.stringify can't compare a DB row with fresh data. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x);

type SlideEditInput = { id: string; createdBy: string; note?: string; render?: boolean; baseVersion?: number };

/**
 * Shared path for every slide change. Reads the CURRENT version, applies `fn` to a copy of its slides,
 * validates the result and saves it as a NEW version, then renders it (render: false skips).
 *
 * neon-http has no transactions, so the version switch is a compare-and-swap:
 *  1. insert the version row as max+1 (the unique (carousel_id, number) index rejects a racing duplicate → retry),
 *  2. UPDATE carousels SET current_version = new WHERE current_version = expected AND not trashed RETURNING,
 *  3. no row back → delete the inserted version and throw "stale: current version is N".
 * expected = the version we read, so a concurrent write is never silently overwritten.
 * `unconditional` (update_slides without baseVersion) skips the version check: the caller replaces everything anyway.
 *
 * If `fn` returns slides identical to the current ones, nothing is saved and `unchanged: true` is returned.
 */
export async function modifySlides(
  input: SlideEditInput,
  fn: (slides: Slide[]) => Slide[],
  opts: { unconditional?: boolean } = {},
) {
  const db = getDb();
  const [c] = await db.select().from(carousels).where(eq(carousels.id, input.id));
  if (!c) throw new Error(`carousel ${input.id} not found`);
  if (c.deletedAt) throw new Error('carousel is in the trash; restore_carousel first');
  if (input.baseVersion != null && c.currentVersion !== input.baseVersion) {
    throw new Error(`stale: current version is ${c.currentVersion}`);
  }
  const [cur] = await db.select({ slides: versions.slides, images: versions.images }).from(versions)
    .where(and(eq(versions.carouselId, c.id), eq(versions.number, c.currentVersion)));
  if (!cur) throw new Error(`current version ${c.currentVersion} not found`);

  const { slides, notes } = prepareSlides(fn(structuredClone(cur.slides)));
  if (canonical(slides) === canonical(cur.slides)) {
    return { id: c.id, version: c.currentVersion, previousVersion: c.currentVersion, unchanged: true, slides, images: cur.images, warnings: [] as SlideWarnings };
  }
  const { pngs, lint } = await renderChecked(slides, c.tipNumber, notes, input.render !== false);

  // 1. Insert the new version row with the next free number.
  let number = 0;
  for (let attempt = 0; ; attempt++) {
    const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${versions.number}), 0)::int` }).from(versions).where(eq(versions.carouselId, c.id));
    number = max + 1;
    try {
      await db.insert(versions).values({ carouselId: c.id, number, slides, lint, createdBy: input.createdBy, note: input.note ?? null });
      break;
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= 3) throw err;
    }
  }

  // 2. Compare-and-swap the current version.
  const expected = opts.unconditional && input.baseVersion == null ? null : (input.baseVersion ?? c.currentVersion);
  const [swapped] = await db.update(carousels).set({ currentVersion: number, status: 'review', updatedAt: new Date() })
    .where(and(eq(carousels.id, c.id), isNull(carousels.deletedAt), expected == null ? undefined : eq(carousels.currentVersion, expected)))
    .returning({ id: carousels.id });

  // 3. Lost the race (or trashed meanwhile): undo the insert and report.
  if (!swapped) {
    await db.delete(versions).where(and(eq(versions.carouselId, c.id), eq(versions.number, number)));
    const [now] = await db.select({ currentVersion: carousels.currentVersion, deletedAt: carousels.deletedAt }).from(carousels).where(eq(carousels.id, c.id));
    if (!now) throw new Error(`carousel ${c.id} not found`);
    if (now.deletedAt) throw new Error('carousel is in the trash; restore_carousel first');
    throw new Error(`stale: current version is ${now.currentVersion}`);
  }

  const images = await saveImages(c.id, number, pngs);
  return { id: c.id, version: number, previousVersion: c.currentVersion, unchanged: false, slides, images, warnings: slideWarnings(lint) };
}

/** Replaces all slides as a NEW version (old versions are kept) and renders it. Throws "stale" if baseVersion is given and doesn't match. */
export async function updateSlides(input: SlideEditInput & { slides: Slide[] }) {
  const { slides, ...rest } = input;
  const r = await modifySlides(rest, () => slides, { unconditional: true });
  return { id: r.id, version: r.version, images: r.images, ...(r.unchanged ? { unchanged: true } : {}), ...(r.warnings.length ? { warnings: r.warnings } : {}) };
}

/** Slide numbers here are 1-based (the MCP boundary). */
const checkPos = (n: number, count: number, what = 'slide') => {
  if (!Number.isInteger(n) || n < 1 || n > count) throw new Error(`${what} ${n} out of range: this version has ${count} slides (1-${count})`);
};

const slideShapes = Slide.options.map(o => ({ kind: o.shape.kind.value as string, keys: Object.keys(o.shape) }));

/**
 * Shallow-merges `patch` into slide n. A null value removes that field. `kind` may change only if the
 * result validates; fields of the old kind that the new kind does not have are dropped (reported in `dropped`).
 * Fields in the patch that the resulting kind does not know are an error (catches typos).
 */
export async function editSlide(input: SlideEditInput & { slide: number; patch: Record<string, unknown> }) {
  let dropped: string[] = [];
  const r = await modifySlides(input, slides => {
    checkPos(input.slide, slides.length);
    const merged: Record<string, unknown> = { ...slides[input.slide - 1] };
    for (const [k, v] of Object.entries(input.patch)) {
      if (v === null) delete merged[k]; else merged[k] = v;
    }
    const shape = slideShapes.find(s => s.kind === merged.kind);
    if (!shape) throw new Error(`invalid kind ${JSON.stringify(merged.kind)}: use ${slideShapes.map(s => s.kind).join(', ')}`);
    const unknown = Object.keys(input.patch).filter(k => input.patch[k] !== null && !shape.keys.includes(k));
    if (unknown.length) throw new Error(`unknown field(s) for a ${shape.kind} slide: ${unknown.join(', ')}. Valid: ${shape.keys.join(', ')}`);
    dropped = Object.keys(merged).filter(k => !shape.keys.includes(k));
    const one = Slide.safeParse(merged);
    if (!one.success) throw new Error(`slide ${input.slide} would be invalid: ${zodMessage(one.error)}`);
    slides[input.slide - 1] = one.data;
    return slides;
  });
  return { ...r, slide: input.slide, dropped };
}

/** Inserts a slide BEFORE position `at` (1-based); at = count+1 appends. */
export async function insertSlide(input: SlideEditInput & { at: number; slide: Slide }) {
  return modifySlides(input, slides => {
    if (!Number.isInteger(input.at) || input.at < 1 || input.at > slides.length + 1) {
      throw new Error(`position ${input.at} out of range: this version has ${slides.length} slides; use 1-${slides.length + 1} (${slides.length + 1} appends)`);
    }
    slides.splice(input.at - 1, 0, input.slide);
    return slides;
  });
}

/** Removes slide n (1-based). Refuses to leave fewer than 2 slides. */
export async function removeSlide(input: SlideEditInput & { slide: number }) {
  const removed: Slide[] = [];
  const r = await modifySlides(input, slides => {
    checkPos(input.slide, slides.length);
    if (slides.length - 1 < 2) throw new Error(`cannot remove: a carousel needs at least 2 slides and this version has ${slides.length}`);
    removed.push(...slides.splice(input.slide - 1, 1));
    return slides;
  });
  return { ...r, removed: removed[0] };
}

/** Moves slide `from` to position `to` (both 1-based, positions in the resulting order). */
export async function moveSlide(input: SlideEditInput & { from: number; to: number }) {
  return modifySlides(input, slides => {
    checkPos(input.from, slides.length, 'from');
    checkPos(input.to, slides.length, 'to');
    const [s] = slides.splice(input.from - 1, 1);
    slides.splice(input.to - 1, 0, s);
    return slides;
  });
}

export async function renderCarousel(id: string, version?: number) {
  const got = await getCarousel(id, version);
  if (!got?.version) throw new Error('carousel or version not found');
  const brand = await getBrand();
  const r = await renderSlides(got.version.slides, tipLabel(brand, got.carousel.tipNumber), brand);
  const lint = r.map(x => x.lint);
  const images = await uploadPngs(id, got.version.number, r.map(x => x.png));
  await getDb().update(versions).set({ images, lint }).where(and(eq(versions.carouselId, id), eq(versions.number, got.version.number)));
  const warnings = slideWarnings(lint);
  const errors = lint.flatMap((l, i) => (l?.errors.length ? [{ n: i + 1, errors: l.errors }] : []));
  return { id, version: got.version.number, images, ...(warnings.length ? { warnings } : {}), ...(errors.length ? { errors } : {}) };
}

export async function updateCarousel(id: string, patch: { status?: Status; title?: string; tipNumber?: number | null; currentVersion?: number }) {
  const [c] = await getDb().update(carousels).set({ ...patch, updatedAt: new Date() }).where(eq(carousels.id, id)).returning();
  return c ?? null;
}

/** Soft delete (moves to trash). Idempotent: an already-trashed carousel keeps its original deleted_at. */
export async function deleteCarousel(id: string) {
  const [c] = await getDb().update(carousels).set({ deletedAt: sql`coalesce(${carousels.deletedAt}, now())`, updatedAt: new Date() })
    .where(eq(carousels.id, id)).returning();
  return c ?? null;
}

/** Takes a carousel out of the trash. */
export async function restoreCarousel(id: string) {
  const [c] = await getDb().update(carousels).set({ deletedAt: null, updatedAt: new Date() }).where(eq(carousels.id, id)).returning();
  return c ?? null;
}

/** Permanent delete, only from the trash (one atomic DELETE ... WHERE deleted_at IS NOT NULL). Also removes its Blob images. */
export async function purgeCarousel(id: string) {
  const db = getDb();
  const [gone] = await db.delete(carousels).where(and(eq(carousels.id, id), isNotNull(carousels.deletedAt)))
    .returning({ id: carousels.id, title: carousels.title });
  if (!gone) {
    const [c] = await db.select({ id: carousels.id }).from(carousels).where(eq(carousels.id, id));
    throw new Error(c ? 'carousel is not in the trash; delete_carousel it first' : `carousel ${id} not found`);
  }
  let blobsDeleted = 0;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: `carousels/${id}/`, cursor, limit: 1000 });
      if (page.blobs.length) await del(page.blobs.map(b => b.url));
      blobsDeleted += page.blobs.length;
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  return { id, title: gone.title, purged: true, blobsDeleted };
}

/** Copies one version (default current) of a carousel into a NEW carousel as v1. */
export async function duplicateCarousel(input: { id: string; version?: number; title?: string; createdBy: string; render?: boolean }) {
  const got = await getCarousel(input.id, input.version);
  if (!got) throw new Error(`carousel ${input.id} not found`);
  if (!got.version) throw new Error(`version ${input.version} not found`);
  return createCarousel({
    title: input.title?.trim() || `${got.carousel.title} (copy)`,
    tipNumber: got.carousel.tipNumber,
    slides: got.version.slides,
    createdBy: input.createdBy,
    note: `Copied from "${got.carousel.title}" v${got.version.number}`,
    render: input.render,
  });
}

/** Points the carousel at an existing version (atomic: no-op if that version does not exist). */
export async function setCurrentVersion(id: string, version: number) {
  const db = getDb();
  const [c] = await db.update(carousels).set({ currentVersion: version, updatedAt: new Date() })
    .where(and(eq(carousels.id, id), sql`exists (select 1 from ${versions} where ${versions.carouselId} = ${id} and ${versions.number} = ${version})`))
    .returning();
  if (c) return c;
  const [exists] = await db.select({ id: carousels.id }).from(carousels).where(eq(carousels.id, id));
  throw new Error(exists ? `version ${version} not found` : `carousel ${id} not found`);
}

export type SlideChange =
  | { slide: number; change: 'added' | 'removed'; kind: string }
  | { slide: number; change: 'changed'; fields: Record<string, { from: unknown; to: unknown }> };

/** Position-by-position diff of two slide arrays. Slide numbers are 1-based. */
export function diffSlides(a: Slide[], b: Slide[]): SlideChange[] {
  const out: SlideChange[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] as Record<string, unknown> | undefined;
    const y = b[i] as Record<string, unknown> | undefined;
    if (!x) { out.push({ slide: i + 1, change: 'added', kind: String(y!.kind) }); continue; }
    if (!y) { out.push({ slide: i + 1, change: 'removed', kind: String(x.kind) }); continue; }
    const fields: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) fields[k] = { from: x[k] ?? null, to: y[k] ?? null };
    }
    if (Object.keys(fields).length) out.push({ slide: i + 1, change: 'changed', fields });
  }
  return out;
}

export async function compareVersions(id: string, a: number, b: number) {
  const vs = await getDb().select({ number: versions.number, slides: versions.slides }).from(versions)
    .where(and(eq(versions.carouselId, id), inArray(versions.number, [a, b])));
  const va = vs.find(v => v.number === a);
  const vb = vs.find(v => v.number === b);
  if (!va || !vb) throw new Error(`version ${!va ? a : b} not found for carousel ${id}`);
  return { id, a, b, slideCount: { a: va.slides.length, b: vb.slides.length }, changes: diffSlides(va.slides, vb.slides) };
}

// ---------- requests (the queue agents work from) ----------

export async function addRequest(input: { kind: 'note' | 'new'; text: string; carouselId?: string; versionNumber?: number; slideIndex?: number; x?: number; y?: number }) {
  const [r] = await getDb().insert(requests).values(input).returning();
  return r;
}

export async function listRequests(filter: { status?: RequestStatus | 'active'; carouselId?: string } = {}) {
  const status = filter.status ?? 'active';
  const where = and(
    status === 'active' ? inArray(requests.status, ['open', 'claimed']) : eq(requests.status, status),
    filter.carouselId ? eq(requests.carouselId, filter.carouselId) : undefined,
  );
  return getDb().select().from(requests).where(where).orderBy(requests.createdAt);
}

/** Atomically claims an open request (or one whose lease expired). Returns null if someone else holds it. */
export async function claimRequest(id: string, agent: string) {
  const expired = new Date(Date.now() - LEASE_MINUTES * 60_000);
  const [r] = await getDb().update(requests)
    .set({ status: 'claimed', claimedBy: agent, claimedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(requests.id, id), or(eq(requests.status, 'open'), and(eq(requests.status, 'claimed'), lt(requests.claimedAt, expired)), and(eq(requests.status, 'claimed'), eq(requests.claimedBy, agent)))))
    .returning();
  return r ?? null;
}

export async function completeRequest(id: string, agent: string, reply: string, resultVersion?: number, carouselId?: string) {
  const [r] = await getDb().update(requests)
    .set({ status: 'done', reply, resultVersion: resultVersion ?? null, carouselId: carouselId ?? sql`${requests.carouselId}`, claimedBy: agent, updatedAt: new Date() })
    .where(eq(requests.id, id)).returning();
  return r ?? null;
}

export async function setRequestStatus(id: string, status: RequestStatus) {
  await getDb().update(requests).set({ status, updatedAt: new Date() }).where(eq(requests.id, id));
}

export async function getRequest(id: string) {
  const [r] = await getDb().select().from(requests).where(eq(requests.id, id));
  return r ?? null;
}

/** Atomic open/claimed -> dismissed. Returns { row, changed }; row null if the id is unknown. */
export async function dismissRequest(id: string) {
  const [r] = await getDb().update(requests).set({ status: 'dismissed', updatedAt: new Date() })
    .where(and(eq(requests.id, id), inArray(requests.status, ['open', 'claimed']))).returning();
  return r ? { row: r, changed: true } : { row: await getRequest(id), changed: false };
}

/** Atomic done/dismissed -> open, clearing claim and result fields. */
export async function reopenRequest(id: string) {
  const [r] = await getDb().update(requests)
    .set({ status: 'open', claimedBy: null, claimedAt: null, reply: null, resultVersion: null, updatedAt: new Date() })
    .where(and(eq(requests.id, id), inArray(requests.status, ['done', 'dismissed']))).returning();
  return r ? { row: r, changed: true } : { row: await getRequest(id), changed: false };
}

// ---------- activity log ----------

/** Best-effort: a failed log write never fails the action that caused it. */
export async function logActivity(actor: string, action: string, carouselId?: string | null, detail?: Record<string, unknown> | null) {
  try {
    await getDb().insert(schema.activity).values({ actor, action, carouselId: carouselId ?? null, detail: detail ?? null });
  } catch (err) {
    console.error('activity log failed', action, err instanceof Error ? err.message : err);
  }
}

export async function listActivity(filter: { carouselId?: string; limit?: number } = {}) {
  const { activity } = schema;
  return getDb().select().from(activity)
    .where(filter.carouselId ? eq(activity.carouselId, filter.carouselId) : undefined)
    .orderBy(desc(activity.createdAt)).limit(Math.min(filter.limit ?? 50, 200));
}

type RequestRow = typeof requests.$inferSelect;
/** Request as agents see it: 0-based slideIndex becomes 1-based `slide`. */
export function requestOut(r: RequestRow) {
  const { slideIndex, ...rest } = r;
  return { ...rest, slide: slideIndex == null ? null : slideIndex + 1 };
}
