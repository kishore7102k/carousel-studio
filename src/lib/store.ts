import { and, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
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

/** Soft delete: sets deleted_at. Use purgeCarousel for a hard delete. */
export async function deleteCarousel(id: string) {
  const [c] = await getDb().update(carousels).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(carousels.id, id)).returning();
  return c ?? null;
}

/** Clears soft delete. */
export async function restoreCarousel(id: string) {
  const [c] = await getDb().update(carousels).set({ deletedAt: null, updatedAt: new Date() }).where(eq(carousels.id, id)).returning();
  return c ?? null;
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
