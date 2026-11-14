import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { agentOf, defineTool, fail, json } from '@/lib/mcp/define';
import { deleteAsset, listAssets, uploadAsset, MAX_ASSET_BYTES } from '@/lib/assets';
import { deleteLayout, getLayout, listLayouts, saveLayout, type Layout } from '@/lib/layouts';
import * as store from '@/lib/store';
import { getBrand, tipLabel } from '@/lib/brand';
import { designSystem, templateToDesign } from '@/lib/render/design';
import type { DesignSlide, Slide } from '@/lib/slides';

const layoutOut = (l: Layout, withSource = false) => ({
  name: l.name,
  description: l.description,
  placeholders: l.placeholders,
  thumbnail: l.thumbnail,
  createdBy: l.createdBy,
  updatedAt: l.updatedAt,
  ...(withSource ? { html: l.html, css: l.css } : {}),
});

export function registerDesignTools(server: McpServer) {
  // ---------- Assets ----------
  defineTool(server, 'upload_asset', {
    title: 'Upload asset',
    description: `Uploads a PNG, JPEG, WebP or SVG (max ${MAX_ASSET_BYTES / 1024 / 1024} MB) for use in design slides. Type is checked by content, SVG is sanitized (scripts, foreignObject, event handlers and external references removed). Returns { id, url, width, height }; use the url in <img src> or CSS url() inside a design slide. Assets are global, not per carousel.`,
    inputSchema: z.object({
      name: z.string().min(1).max(120).describe('Human label, e.g. "logo.svg".'),
      mimeType: z.string().describe('Declared type (informational; the real type is detected from the bytes).'),
      base64: z.string().min(1).describe('File content, base64 (a data: URL prefix is tolerated).'),
    }),
    scope: 'write',
  }, async (args, ctx) => {
    const a = await uploadAsset({ ...args, createdBy: agentOf(ctx) });
    return json({ id: a.id, url: a.url, kind: a.kind, bytes: a.bytes, width: a.width, height: a.height }, { carouselId: null, detail: { name: args.name, kind: a.kind, bytes: a.bytes, id: a.id } });
  });

  defineTool(server, 'list_assets', {
    title: 'List assets',
    description: 'Uploaded assets (newest first) with id, url, kind, bytes and pixel size.',
    inputSchema: z.object({}),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async () => json((await listAssets()).map(a => ({ id: a.id, url: a.url, kind: a.kind, bytes: a.bytes, width: a.width, height: a.height, createdBy: a.createdBy, createdAt: a.createdAt }))));

  defineTool(server, 'delete_asset', {
    title: 'Delete asset',
    description: 'Permanently deletes an uploaded asset and its file. Slides that still reference its url will show a broken image.',
    inputSchema: z.object({ id: z.string().uuid() }),
    scope: 'write',
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ id }) => (await deleteAsset(id)) ? json({ deleted: id }, { carouselId: null }) : fail(`asset ${id} not found`));

  // ---------- Layouts ----------
  defineTool(server, 'save_layout', {
    title: 'Save layout',
    description: 'Saves a design slide as a reusable named layout. Put {{placeholder}} tokens in html where text should vary (letters, digits, - and _; start with a letter). Create slides from it with { kind: "design", layout: "<name>", fill: { placeholder: "text" } } in create_carousel / update_slides / insert_slide. Fill text supports *marker* and `code` but is HTML-escaped. html/css are sanitized like any design slide. Saving an existing name replaces it. A thumbnail is rendered with each placeholder showing its own name.',
    inputSchema: z.object({
      name: z.string().regex(/^[a-z0-9-]{1,40}$/).describe('Lowercase slug, max 40, e.g. "big-number".'),
      description: z.string().max(300).optional().describe('When to use this layout.'),
      html: z.string().min(1).max(60_000),
      css: z.string().max(30_000).optional(),
    }),
    scope: 'write',
    annotations: { idempotentHint: true },
  }, async (args, ctx) => {
    const l = await saveLayout({ ...args, createdBy: agentOf(ctx) });
    return json(layoutOut(l), { carouselId: null, detail: { name: l.name, placeholders: l.placeholders } });
  });

  defineTool(server, 'list_layouts', {
    title: 'List layouts',
    description: 'Saved layouts with name, description, placeholders and thumbnail URL (no source; use get_layout).',
    inputSchema: z.object({}),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async () => json((await listLayouts()).map(l => layoutOut(l))));

  defineTool(server, 'get_layout', {
    title: 'Get layout',
    description: 'One layout with its html, css and placeholders, so you can remix it.',
    inputSchema: z.object({ name: z.string().min(1) }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ name }) => {
    const l = await getLayout(name);
    return l ? json(layoutOut(l, true)) : fail(`layout "${name}" not found`);
  });

  defineTool(server, 'delete_layout', {
    title: 'Delete layout',
    description: 'Permanently deletes a layout and its thumbnail. Slides already made from it are unaffected (they hold their own copy).',
    inputSchema: z.object({ name: z.string().min(1) }),
    scope: 'write',
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ name }) => (await deleteLayout(name)) ? json({ deleted: name }, { carouselId: null }) : fail(`layout "${name}" not found`));
}

export function registerDesignSystemTools(server: McpServer) {
  defineTool(server, 'get_design_system', {
    title: 'Get design system',
    description: 'The brand layer for design slides as data: canvas and safe area, CSS variables with values, brand classes with example HTML, type scale, spacing, radii, fonts, chrome options and lint rules. Same content as the "Designing slides" section of get_brand_guide.',
    inputSchema: z.object({}),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async () => json(designSystem(await getBrand())));

  defineTool(server, 'get_slide_source', {
    title: 'Get slide source',
    description: 'One slide of a carousel as an editable design slide ({ kind: "design", html, css, chrome }). Template slides (cover, content, code, cta) are converted so they render the same; design slides are returned as they are. Use it to remix a preset or fix a design slide.',
    inputSchema: z.object({ id: z.string().uuid(), slide: z.number().int().positive().describe('1-based slide number'), version: z.number().int().positive().optional() }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ id, slide, version }) => {
    const got = await store.getCarousel(id, version);
    if (!got) return fail(`carousel ${id} not found`);
    if (!got.version) return fail(`version ${version} not found`);
    const slides = got.version.slides;
    const s = slides[slide - 1];
    if (!s) return fail(`slide ${slide} does not exist: the carousel has ${slides.length} slides (1-based)`);
    const brand = await getBrand();
    const isDesign = (s as { kind: string }).kind === 'design';
    const out = isDesign ? (s as unknown as DesignSlide) : templateToDesign(s as Slide, slide - 1, slides.length, tipLabel(brand, got.carousel.tipNumber), brand);
    return json({ version: got.version.number, slide, source: isDesign ? 'design' : `converted from ${s.kind}`, design: out });
  });
}
