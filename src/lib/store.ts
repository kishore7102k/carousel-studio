import { and, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { del, list } from '@vercel/blob';
import { getDb, schema } from '@/db';
import { renderAndUpload } from '@/lib/render/render';
import { Slides, type Slide } from '@/lib/slides';
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

async function render(id: string, number: number, slides: Slide[], tip: number | null) {
  const brand = await getBrand();
  const images = await renderAndUpload(id, number, slides, tipLabel(brand, tip), brand);
  await getDb().update(versions).set({ images }).where(and(eq(versions.carouselId, id), eq(versions.number, number)));
  return images;
}

export async function createCarousel(input: { title: string; tipNumber?: number | null; slides: Slide[]; createdBy: string; note?: string; render?: boolean }) {
  const slides = Slides.parse(input.slides);
  const db = getDb();
  const [c] = await db.insert(carousels).values({ title: input.title, tipNumber: input.tipNumber ?? null, status: 'review' }).returning();
  await db.insert(versions).values({ carouselId: c.id, number: 1, slides, createdBy: input.createdBy, note: input.note ?? 'First version' });
  const images = input.render === false ? [] : await render(c.id, 1, slides, c.tipNumber);
  return { id: c.id, version: 1, images };
}

/** Saves slides as a NEW version (old versions are kept) and renders it. Throws "stale" if baseVersion is given and doesn't match. */
export async function updateSlides(input: { id: string; slides: Slide[]; createdBy: string; note?: string; render?: boolean; baseVersion?: number }) {
  const slides = Slides.parse(input.slides);
  const db = getDb();
  const [c] = await db.select().from(carousels).where(eq(carousels.id, input.id));
  if (!c) throw new Error(`carousel ${input.id} not found`);
  if (input.baseVersion != null && c.currentVersion !== input.baseVersion) {
    throw new Error(`stale: current version is ${c.currentVersion}`);
  }
  const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${versions.number}), 0)::int` }).from(versions).where(eq(versions.carouselId, c.id));
  const number = max + 1;
  await db.insert(versions).values({ carouselId: c.id, number, slides, createdBy: input.createdBy, note: input.note ?? null });
  await db.update(carousels).set({ currentVersion: number, status: 'review', updatedAt: new Date() }).where(eq(carousels.id, c.id));
  const images = input.render === false ? [] : await render(c.id, number, slides, c.tipNumber);
  return { id: c.id, version: number, images };
}

export async function renderCarousel(id: string, version?: number) {
  const got = await getCarousel(id, version);
  if (!got?.version) throw new Error('carousel or version not found');
  const images = await render(id, got.version.number, got.version.slides, got.carousel.tipNumber);
  return { id, version: got.version.number, images };
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
