// Design self-check: remember which slide designs an agent previewed, so saves can flag slides nobody looked at.
import { createHash } from 'node:crypto';
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import type { Slide } from '@/lib/slides';

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Hash of what a design slide looks like (html, css, ground, chrome); null for legacy template slides. */
export function slideHash(s: Slide): string | null {
  if (s.kind !== 'design') return null;
  return createHash('sha256').update([s.html.trim(), (s.css ?? '').trim(), s.ground ?? '', s.chrome ?? ''].join('\u0000')).digest('hex');
}

export async function recordPreview(actor: string, slide: Slide) {
  const hash = slideHash(slide);
  if (!hash) return;
  try {
    const db = getDb();
    await db.insert(schema.slidePreviews).values({ hash, actor }).onConflictDoUpdate({ target: [schema.slidePreviews.actor, schema.slidePreviews.hash], set: { at: new Date() } });
    if (Math.random() < 0.05) await db.delete(schema.slidePreviews).where(lt(schema.slidePreviews.at, new Date(Date.now() - WINDOW_MS)));
  } catch { /* best-effort */ }
}

/**
 * 1-based numbers (offset by `firstN`) of design slides this actor saved without previewing that exact design in
 * the last 24 h. Returns a ready-made reminder for the tool response, or null when every slide was previewed.
 */
export async function selfCheck(actor: string, slides: Slide[], firstN = 1): Promise<{ notPreviewed: number[]; reminder: string } | null> {
  const items = slides.map((s, i) => ({ n: i + firstN, hash: slideHash(s) })).filter((x): x is { n: number; hash: string } => !!x.hash);
  if (!items.length) return null;
  let seen = new Set<string>();
  try {
    const rows = await getDb().select({ hash: schema.slidePreviews.hash }).from(schema.slidePreviews)
      .where(and(eq(schema.slidePreviews.actor, actor), inArray(schema.slidePreviews.hash, items.map(x => x.hash)), gt(schema.slidePreviews.at, new Date(Date.now() - WINDOW_MS))));
    seen = new Set(rows.map(r => r.hash));
  } catch { return null; }
  const notPreviewed = items.filter(x => !seen.has(x.hash)).map(x => x.n);
  if (!notPreviewed.length) return null;
  return {
    notPreviewed,
    reminder: `Design self-check skipped for slide(s) ${notPreviewed.join(', ')}: they were saved without preview_slide. Preview each one, LOOK at the image, run the self-check from get_brand_guide ("Before you save"), and fix with edit_slide if needed.`,
  };
}
