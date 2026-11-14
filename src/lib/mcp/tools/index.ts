/**
 * Tool registration entry point.
 * Item 3: single-file registration through defineTool (scope check, errors, activity log).
 * Item 4: each group will be split into its own module (carousels, slides, render, requests, brand, access, compat).
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getBrand } from '@/lib/brand';
import { Slides, SLIDE_FORMAT_GUIDE } from '@/lib/slides';
import * as store from '@/lib/store';
import { defineTool, studioUrl, json, fail, agentOf } from '@/lib/mcp/server';

const WORKFLOW = `Carousel Studio workflow for agents:
1. Call get_brand_guide once per session and follow it (voice, one marked phrase per slide, limits). Scopes on your key: read, write, or admin. Slide numbers in tool inputs/outputs are 1-based.
2. list_requests shows what the human asked for: "note" = feedback pinned on a slide (slideIndex, x/y as 0-1 fractions of the image), "new" = make a new carousel from the text.
3. claim_request before working on one (another agent may hold it; leases expire after 30 min).
4. Make the change: update_slides for notes (saves a new version and renders), create_carousel for "new".
5. Optionally view_slides to check the rendered result.
6. complete_request with a one-line reply and the resulting version.`;

export function registerAllTools(server: McpServer) {
  // ── brand guide ─────────────────────────────────────────────────────────────
  defineTool(server, 'get_brand_guide', {
    title: 'Get brand guide',
    description: 'Brand book, slide JSON format and agent workflow. Read once before writing or editing slides. Also describes scopes (read/write/admin) and 1-based slide numbering.',
    inputSchema: z.object({}),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async () => {
    const b = await getBrand();
    return {
      content: [{
        type: 'text',
        text: `${WORKFLOW}\n\n# Slide format\n${SLIDE_FORMAT_GUIDE}\n\n# Brand: ${b.name}\nHandle on slides: ${b.handle}. Label: "${b.labelPrefix} 014".\n\n${b.readme}`,
      }],
    };
  });

  // ── list_carousels ───────────────────────────────────────────────────────────
  defineTool(server, 'list_carousels', {
    title: 'List carousels',
    description: 'All carousels, newest first, with status, current version, cover image and open request count. Filter by status or query (title search). Trashed carousels are excluded unless includeTrashed is true.',
    inputSchema: z.object({
      query: z.string().optional().describe('Filter by title (case-insensitive substring match)'),
      status: z.enum(['draft', 'review', 'approved', 'posted']).optional(),
      includeTrashed: z.boolean().optional().describe('Include soft-deleted carousels (default false)'),
      limit: z.number().int().positive().max(200).optional().describe('Max results (default 50)'),
    }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ status, query, includeTrashed, limit }) => {
    const rows = await store.listCarousels({ status, query, includeTrashed: includeTrashed ?? false, limit: limit ?? 50 });
    return json(rows.map(c => ({ id: c.id, title: c.title, tipNumber: c.tipNumber, status: c.status, currentVersion: c.currentVersion, cover: c.cover, openRequests: c.openRequests, updatedAt: c.updatedAt, deletedAt: c.deletedAt ?? null, url: studioUrl(`/carousel/${c.id}`) })));
  });

  // ── get_carousel ─────────────────────────────────────────────────────────────
  defineTool(server, 'get_carousel', {
    title: 'Get carousel',
    description: 'One carousel: slides JSON and image URLs for a version (default current), version history and all requests. Slide objects include a 1-based "n" field in the output.',
    inputSchema: z.object({ id: z.string().uuid(), version: z.number().int().positive().optional() }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ id, version }) => {
    const got = await store.getCarousel(id, version);
    if (!got) return fail(`carousel ${id} not found`);
    // Add 1-based n to slides in output
    const slides = got.version?.slides.map((s, i) => ({ n: i + 1, ...s })) ?? [];
    const url = studioUrl(`/carousel/${id}`);
    return json({ ...got, version: got.version ? { ...got.version, slides } : null, url });
  });

  // ── create_carousel ──────────────────────────────────────────────────────────
  defineTool(server, 'create_carousel', {
    title: 'Create carousel',
    description: 'Creates a carousel as version 1 and renders it to 1080×1350 PNGs. Follow the brand guide. Returns the carousel id, version number, image URLs, and a studio link.',
    inputSchema: z.object({
      title: z.string().min(1).describe('Internal title, e.g. "Native date input"'),
      tipNumber: z.number().int().positive().optional().describe('Series number shown on the cover label (e.g. "Tip 014"). Use the next number after the highest existing one.'),
      slides: Slides,
      note: z.string().optional().describe('What this version is.'),
      render: z.boolean().optional().describe('Set false to skip rendering (faster; call render_carousel later)'),
    }),
    scope: 'write',
  }, async (args, ctx) => {
    const result = await store.createCarousel({ ...args, createdBy: agentOf(ctx) });
    return json({ ...result, url: studioUrl(`/carousel/${result.id}`) });
  });

  // ── update_slides ────────────────────────────────────────────────────────────
  defineTool(server, 'update_slides', {
    title: 'Update slides',
    description: 'Saves the full slides array as a NEW version (old versions are kept) and renders it. Send every slide, not a diff. Use edit_slide / insert_slide / remove_slide / move_slide for targeted edits. Optional baseVersion for optimistic concurrency: fails with "stale" if the carousel has moved on.',
    inputSchema: z.object({
      id: z.string().uuid(),
      slides: Slides,
      note: z.string().optional().describe('What changed, e.g. "Bigger code on slide 3"'),
      baseVersion: z.number().int().positive().optional().describe('Expected current version; fails with stale if the carousel is at a different version'),
      render: z.boolean().optional().describe('Set false to skip rendering'),
    }),
    scope: 'write',
  }, async (args, ctx) => {
    const result = await store.updateSlides({ ...args, createdBy: agentOf(ctx) });
    return json({ ...result, url: studioUrl(`/carousel/${args.id}`) });
  });

  // ── render_carousel ──────────────────────────────────────────────────────────
  defineTool(server, 'render_carousel', {
    title: 'Render carousel',
    description: 'Re-renders a version (default current) to PNGs and returns the image URLs. Use when render: false was passed to create/update tools, or to refresh after a brand change.',
    inputSchema: z.object({ id: z.string().uuid(), version: z.number().int().positive().optional() }),
    scope: 'write',
    annotations: { idempotentHint: true },
  }, async ({ id, version }) => {
    const result = await store.renderCarousel(id, version);
    return json({ ...result, url: studioUrl(`/carousel/${id}`) });
  });

  // ── view_slides ──────────────────────────────────────────────────────────────
  defineTool(server, 'view_slides', {
    title: 'View slides',
    description: 'Returns the rendered slide images for visual review, plus image URLs as text (some clients do not render MCP image content). Call render_carousel first if no images exist.',
    inputSchema: z.object({
      id: z.string().uuid(),
      version: z.number().int().positive().optional(),
      slides: z.array(z.number().int().min(1)).optional().describe('1-based slide numbers; default all'),
    }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ id, version, slides }) => {
    const got = await store.getCarousel(id, version);
    if (!got?.version?.images.length) return fail('no rendered images for that version; call render_carousel first');
    const pick = got.version.images.map((url, i) => ({ url, n: i + 1 })).filter(s => !slides || slides.includes(s.n));
    const urlText = pick.map(s => `slide ${s.n}: ${s.url}`).join('\n');
    const images = await Promise.all(
      pick.map(async s => ({ type: 'image' as const, mimeType: 'image/png', data: Buffer.from(await (await fetch(s.url)).arrayBuffer()).toString('base64') }))
    );
    return { content: [{ type: 'text' as const, text: `Version ${got.version.number}, slides ${pick.map(s => s.n).join(', ')}\n\nImage URLs:\n${urlText}` }, ...images] };
  });

  // ── set_carousel_status (kept as-is for backward compat; item 5 adds update_carousel) ──
  defineTool(server, 'set_carousel_status', {
    title: 'Set carousel status',
    description: 'draft → review → approved → posted. Only the human approves; agents normally leave status alone.',
    inputSchema: z.object({ id: z.string().uuid(), status: z.enum(['draft', 'review', 'approved', 'posted']) }),
    scope: 'write',
    annotations: { idempotentHint: true },
  }, async ({ id, status }) => {
    const c = await store.updateCarousel(id, { status });
    return c ? json(c) : fail(`carousel ${id} not found`);
  });

  // ── list_requests ────────────────────────────────────────────────────────────
  defineTool(server, 'list_requests', {
    title: 'List requests',
    description: 'The human\'s queue: notes pinned on slides and new-carousel prompts. Default: open and claimed. Slide numbers in output are 1-based.',
    inputSchema: z.object({
      status: z.enum(['active', 'open', 'claimed', 'done', 'dismissed']).optional(),
      carouselId: z.string().uuid().optional(),
    }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async args => {
    const rows = await store.listRequests(args);
    // Convert 0-based slideIndex to 1-based for output
    return json(rows.map(r => ({ ...r, slide: r.slideIndex != null ? r.slideIndex + 1 : null })));
  });

  // ── claim_request ────────────────────────────────────────────────────────────
  defineTool(server, 'claim_request', {
    title: 'Claim request',
    description: 'Locks a request for you for 30 minutes so other agents skip it. Fails if another agent holds it. Use idempotently: re-claiming your own request refreshes the lease.',
    inputSchema: z.object({ id: z.string().uuid() }),
    scope: 'write',
    annotations: { idempotentHint: true },
  }, async ({ id }, ctx) => {
    const r = await store.claimRequest(id, agentOf(ctx));
    return r ? json(r) : fail('request is held by another agent or already done');
  });

  // ── complete_request ─────────────────────────────────────────────────────────
  defineTool(server, 'complete_request', {
    title: 'Complete request',
    description: 'Marks a request done with a short reply the human will read.',
    inputSchema: z.object({
      id: z.string().uuid(),
      reply: z.string().min(1).describe('One line: what you changed.'),
      resultVersion: z.number().int().positive().optional().describe('Version created by the change.'),
      carouselId: z.string().uuid().optional().describe('For "new" requests: the carousel you created.'),
    }),
    scope: 'write',
  }, async ({ id, reply, resultVersion, carouselId }, ctx) => {
    const r = await store.completeRequest(id, agentOf(ctx), reply, resultVersion, carouselId);
    return r ? json(r) : fail(`request ${id} not found`);
  });
}
