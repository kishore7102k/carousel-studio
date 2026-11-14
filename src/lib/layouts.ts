// Phase 3 reusable design layouts: named design slides with {{placeholders}}.
import { put, del } from '@vercel/blob';
import { asc, eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { inline } from '@/lib/render/html';
import { previewSlide, sanitizeDesign } from '@/lib/render/design';
import type { DesignSlide, LayoutRef, Slide } from '@/lib/slides';

export type Layout = { id: string; name: string; description: string; html: string; css: string; placeholders: string[]; thumbnail: string | null; createdBy: string; createdAt: Date; updatedAt: Date };

const NAME_RE = /^[a-z0-9-]{1,40}$/;
const TOKEN_RE = /\{\{\s*([A-Za-z][\w-]{0,39})\s*\}\}/g;

export const placeholdersOf = (html: string): string[] => [...new Set([...html.matchAll(TOKEN_RE)].map(m => m[1]))];

/** Replaces every {{name}} in one pass (values are never re-scanned) with the escaped value. */
function fillHtml(html: string, fill: Record<string, string>): string {
  return html.replace(TOKEN_RE, (_, k: string) => inline(fill[k] ?? ''));
}

export async function listLayouts(): Promise<Layout[]> {
  return getDb().select().from(schema.layouts).orderBy(asc(schema.layouts.name));
}

export async function getLayout(name: string): Promise<Layout | null> {
  const [row] = await getDb().select().from(schema.layouts).where(eq(schema.layouts.name, name));
  return row ?? null;
}

export async function saveLayout(input: { name: string; description?: string; html: string; css?: string; createdBy: string }): Promise<Layout> {
  if (!NAME_RE.test(input.name)) throw new Error('layout name must be a lowercase slug (a-z, 0-9, "-"), max 40 characters');
  const clean = sanitizeDesign({ html: input.html, css: input.css });
  const placeholders = placeholdersOf(clean.html);
  const db = getDb();
  const [row] = await db.insert(schema.layouts).values({
    name: input.name, description: input.description ?? '', html: clean.html, css: clean.css, placeholders, createdBy: input.createdBy,
  }).onConflictDoUpdate({
    target: schema.layouts.name,
    set: { description: input.description ?? '', html: clean.html, css: clean.css, placeholders, updatedAt: new Date() },
  }).returning();

  // Thumbnail: every placeholder shows its own name. Failure just leaves it null.
  let thumbnail: string | null = null;
  try {
    const fill = Object.fromEntries(placeholders.map(p => [p, p]));
    const { png } = await previewSlide({ kind: 'design', html: fillHtml(clean.html, fill), css: clean.css, name: input.name } as DesignSlide);
    thumbnail = (await put(`layouts/${row.id}.png`, png, { access: 'public', contentType: 'image/png', allowOverwrite: true, addRandomSuffix: false })).url;
  } catch { thumbnail = null; }
  const [saved] = await db.update(schema.layouts).set({ thumbnail }).where(eq(schema.layouts.id, row.id)).returning();
  return saved;
}

export async function deleteLayout(name: string): Promise<boolean> {
  const [row] = await getDb().delete(schema.layouts).where(eq(schema.layouts.name, name)).returning();
  if (!row) return false;
  if (row.thumbnail) await del(row.thumbnail).catch(() => {});
  return true;
}

/** Fills a layout's {{placeholders}} (escaped text, *marker* and `code` allowed) into a DesignSlide. */
export async function applyLayout(ref: LayoutRef): Promise<DesignSlide> {
  const layout = await getLayout(ref.layout);
  if (!layout) {
    const names = (await listLayouts()).map(l => l.name);
    throw new Error(`unknown layout "${ref.layout}". ${names.length ? `Available: ${names.join(', ')}` : 'No layouts saved yet (save_layout).'}`);
  }
  const fill = ref.fill ?? {};
  const missing = layout.placeholders.filter(p => typeof fill[p] !== 'string');
  if (missing.length) throw new Error(`layout "${layout.name}" needs fill values for: ${missing.join(', ')}`);
  const extra = Object.keys(fill).filter(k => !layout.placeholders.includes(k));
  if (extra.length) throw new Error(`layout "${layout.name}" has no placeholder(s): ${extra.join(', ')}. Placeholders: ${layout.placeholders.join(', ') || '(none)'}`);
  return {
    kind: 'design',
    html: fillHtml(layout.html, fill),
    ...(layout.css ? { css: layout.css } : {}),
    ...(ref.chrome ? { chrome: ref.chrome } : {}),
    name: layout.name,
  };
}

/** Resolves any { kind:'design', layout } inputs to DesignSlides; other slides pass through unchanged. */
export async function resolveSlideInputs(slides: (Slide | DesignSlide | LayoutRef)[]): Promise<(Slide | DesignSlide)[]> {
  return Promise.all(slides.map(s => ('layout' in s ? applyLayout(s) : s)));
}
