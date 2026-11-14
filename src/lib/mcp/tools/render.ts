import type { McpServer } from '@modelcontextprotocol/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { del, list, put } from '@vercel/blob';
import * as store from '@/lib/store';
import { carouselUrl, defineTool, fail, json } from '@/lib/mcp/define';
import { Slide, SlideInput } from '@/lib/slides';
import { resolveSlideInputs } from '@/lib/layouts';
import { previewSlide } from '@/lib/render/design';
import { getBrand, tipLabel } from '@/lib/brand';
import { Id, VersionNo } from './carousels';

const PREVIEW_TTL_MS = 60 * 60_000;

/** Lazy cleanup: deletes previews/ blobs older than 1 h. Best effort, never fails the preview. */
async function purgeOldPreviews() {
  try {
    const cutoff = Date.now() - PREVIEW_TTL_MS;
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: 'previews/', cursor, limit: 1000 });
      const old = page.blobs.filter(b => new Date(b.uploadedAt).getTime() < cutoff).map(b => b.url);
      if (old.length) await del(old);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  } catch (err) {
    console.error('preview cleanup failed', err instanceof Error ? err.message : err);
  }
}

export function registerRenderTools(server: McpServer) {
  defineTool(server, 'render_carousel', {
    title: 'Render carousel',
    description: 'Re-renders a version (default current) to PNGs and returns the image URLs. Use after render: false, or to refresh images after a brand change.',
    inputSchema: z.object({ id: Id, version: VersionNo.optional() }),
    scope: 'write',
    annotations: { idempotentHint: true },
    carouselArg: 'id',
  }, async ({ id, version }) => json({ ...(await store.renderCarousel(id, version)), url: carouselUrl(id) }));

  defineTool(server, 'preview_slide', {
    title: 'Preview slide',
    description: 'Renders ONE slide exactly like a saved one (same brand layer, sanitizer and locked-down renderer) WITHOUT saving anything, and returns the PNG plus { errors, warnings } from the design checks. Use it to iterate on design slides before create_carousel / update_slides / edit_slide / insert_slide: fix every error (off-canvas content blocks saving) and as many warnings as you can. Accepts any slide kind, or { kind: "design", layout, fill }. Pass carouselId (and n) to get that carousel\'s tip label and "n / total" counter. The image URL is temporary (deleted after about 1 hour).',
    inputSchema: z.object({
      slide: SlideInput,
      carouselId: Id.optional().describe('Carousel the slide is for: its tip label and slide count are used'),
      n: z.number().int().min(1).max(10).optional().describe('1-based position for the counter (default 1)'),
      total: z.number().int().min(1).max(10).optional().describe('Slide count for the counter (default: the carousel\'s count, else n)'),
    }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ slide, carouselId, n, total }) => {
    const [resolved] = await resolveSlideInputs([slide]);
    const parsed = Slide.safeParse(resolved);
    if (!parsed.success) return fail(`invalid slide: ${store.zodMessage(parsed.error)}`);
    const brand = await getBrand();
    let tip: number | null = null;
    let count = 0;
    if (carouselId) {
      const got = await store.getCarousel(carouselId);
      if (!got) return fail(`carousel ${carouselId} not found`);
      tip = got.carousel.tipNumber;
      count = got.version?.slides.length ?? 0;
    }
    const pos = n ?? 1;
    const t = Math.max(total ?? (count || pos), pos);
    const r = await previewSlide(parsed.data, { n: pos, total: t, tipLabel: tipLabel(brand, tip), brand });
    let url: string | null = null;
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      await purgeOldPreviews();
      url = (await put(`previews/${randomUUID()}.png`, r.png, { access: 'public', contentType: 'image/png', addRandomSuffix: false })).url;
    }
    const verdict = r.errors.length ? 'ERRORS: saving this slide would be refused' : r.warnings.length ? 'OK to save, but fix the warnings if you can' : 'OK: no errors or warnings';
    const text = JSON.stringify({ verdict, errors: r.errors, warnings: r.warnings, n: pos, total: t, image: url, imageExpires: url ? 'about 1 hour' : undefined }, null, 2);
    return { content: [{ type: 'text', text }, { type: 'image', mimeType: 'image/png', data: r.png.toString('base64') }] };
  });

  defineTool(server, 'view_slides', {
    title: 'View slides',
    description: 'Returns the rendered PNGs of a version (default current) as images for visual review, plus their URLs as text for clients that do not display MCP images. Call render_carousel first if nothing is rendered.',
    inputSchema: z.object({
      id: Id,
      version: VersionNo.optional(),
      slides: z.array(z.number().int().min(1)).optional().describe('1-based slide numbers; default all'),
    }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ id, version, slides }) => {
    const got = await store.getCarousel(id, version);
    if (!got) return fail(`carousel ${id} not found`);
    if (!got.version?.images.length) return fail('no rendered images for that version; call render_carousel first');
    const pick = got.version.images.map((url, i) => ({ url, n: i + 1 })).filter(s => !slides || slides.includes(s.n));
    if (!pick.length) return fail(`no such slides; this version has ${got.version.images.length}`);
    const images = await Promise.all(pick.map(async s => {
      const res = await fetch(s.url);
      if (!res.ok) throw new Error(`could not load slide ${s.n} image (${res.status})`);
      return { type: 'image' as const, mimeType: 'image/png', data: Buffer.from(await res.arrayBuffer()).toString('base64') };
    }));
    const text = `Version ${got.version.number}, slides ${pick.map(s => s.n).join(', ')}\n\nImage URLs:\n${pick.map(s => `${s.n}. ${s.url}`).join('\n')}`;
    return { content: [{ type: 'text', text }, ...images] };
  });

  defineTool(server, 'get_download_links', {
    title: 'Get download links',
    description: 'Public PNG URLs (1080x1350) of a version (default current) in slide order, with file names 01.png, 02.png… to save them under. Use it to hand the final images to a publishing step or the user. Fails if the version is not rendered; call render_carousel first.',
    inputSchema: z.object({ id: Id, version: VersionNo.optional() }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ id, version }) => {
    const got = await store.getCarousel(id, version);
    if (!got) return fail(`carousel ${id} not found`);
    if (!got.version) return fail(`version ${version} not found`);
    const { number, images, slides } = got.version;
    if (!images.length) return fail(`version ${number} is not rendered; call render_carousel first`);
    return json({
      id,
      title: got.carousel.title,
      version: number,
      ...(images.length !== slides.length ? { warning: `images (${images.length}) do not match slides (${slides.length}); call render_carousel` } : {}),
      files: images.map((url, i) => ({ n: i + 1, name: `${String(i + 1).padStart(2, '0')}.png`, url })),
      url: carouselUrl(id),
    });
  });
}
