import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import type { Slide } from '@/lib/slides';
import { carouselUrl, studioUrl } from '@/lib/mcp/define';

const { carousels, versions, requests } = schema;

/** Escapes LIKE wildcards so user text is matched literally. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function slidesToText(slides: Slide[]): string {
  return slides.map((s, i) => {
    const lines = [`Slide ${i + 1} (${s.kind})`];
    if (s.kind === 'cover') lines.push(s.hook, ...(s.sub ? [s.sub] : []));
    if (s.kind === 'content') lines.push(s.title, ...(s.points?.map(p => `- ${p}`) ?? []), ...(s.body ? [s.body] : []));
    if (s.kind === 'code') lines.push(...(s.file ? [`File: ${s.file}`] : []), s.code, ...(s.caption ? [s.caption] : []));
    if (s.kind === 'cta') lines.push(s.hook);
    return lines.join('\n');
  }).join('\n\n');
}

/** Search over carousel titles + current-version slide text, and request text. Trashed carousels excluded. */
export async function searchStudio(query: string, limit = 20) {
  const db = getDb();
  const pat = `%${escapeLike(query.trim())}%`;
  const cs = await db.select({ id: carousels.id, title: carousels.title })
    .from(carousels)
    .innerJoin(versions, and(eq(versions.carouselId, carousels.id), eq(versions.number, carousels.currentVersion)))
    .where(and(isNull(carousels.deletedAt), or(ilike(carousels.title, pat), sql`${versions.slides}::text ilike ${pat}`)))
    .orderBy(desc(carousels.updatedAt)).limit(limit);
  const rs = await db.select({ id: requests.id, text: requests.text, kind: requests.kind, status: requests.status, carouselId: requests.carouselId, trashed: carousels.deletedAt })
    .from(requests).leftJoin(carousels, eq(carousels.id, requests.carouselId))
    .where(ilike(requests.text, pat)).orderBy(desc(requests.createdAt)).limit(limit);
  return [
    ...cs.map(c => ({ id: `carousel:${c.id}`, title: c.title, url: carouselUrl(c.id) })),
    ...rs.filter(r => !r.trashed).map(r => ({
      id: `request:${r.id}`,
      title: `Request (${r.kind}, ${r.status}): ${clip(r.text)}`,
      url: r.carouselId ? carouselUrl(r.carouselId) : studioUrl('/'),
    })),
  ];
}

export async function fetchStudio(id: string) {
  const db = getDb();
  const [kind, uuid] = id.split(':');
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) return null;
  if (kind === 'carousel') {
    const [c] = await db.select().from(carousels).where(eq(carousels.id, uuid));
    if (!c) return null;
    const [v] = await db.select().from(versions).where(and(eq(versions.carouselId, uuid), eq(versions.number, c.currentVersion)));
    return {
      id, title: c.title, url: carouselUrl(uuid),
      text: v ? slidesToText(v.slides) : '',
      metadata: { type: 'carousel', status: c.status, tipNumber: c.tipNumber, currentVersion: c.currentVersion, trashed: !!c.deletedAt, updatedAt: c.updatedAt },
    };
  }
  if (kind === 'request') {
    const [r] = await db.select().from(requests).where(eq(requests.id, uuid));
    if (!r) return null;
    return {
      id, title: `Request (${r.kind}, ${r.status}): ${clip(r.text)}`,
      url: r.carouselId ? carouselUrl(r.carouselId) : studioUrl('/'),
      text: r.text,
      metadata: { type: 'request', kind: r.kind, status: r.status, carouselId: r.carouselId, slide: r.slideIndex == null ? null : r.slideIndex + 1, version: r.versionNumber, reply: r.reply, claimedBy: r.claimedBy },
    };
  }
  return null;
}
