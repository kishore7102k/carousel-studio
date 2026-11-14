import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Slides } from '@/lib/slides';
import * as store from '@/lib/store';
import { agentOf, carouselUrl, defineTool, fail, json } from '@/lib/mcp/define';

export const STATUS = z.enum(['draft', 'review', 'approved', 'posted']);
export const Id = z.string().uuid();
export const VersionNo = z.number().int().positive();

export function registerCarouselTools(server: McpServer) {
  defineTool(server, 'list_carousels', {
    title: 'List carousels',
    description: 'Lists carousels, newest first, with status, current version, cover image, open request count and studio url. Filter by title `query` or `status`. Trashed carousels are hidden unless includeTrashed is true.',
    inputSchema: z.object({
      query: z.string().optional().describe('Case-insensitive title search'),
      status: STATUS.optional(),
      includeTrashed: z.boolean().optional().describe('Include carousels in the trash (default false)'),
      limit: z.number().int().positive().max(200).optional().describe('Max results (default 50)'),
    }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ status, query, includeTrashed, limit }) => {
    const rows = await store.listCarousels({ status, query, includeTrashed: includeTrashed ?? false, limit: limit ?? 50 });
    return json(rows.map(c => ({
      id: c.id, title: c.title, tipNumber: c.tipNumber, status: c.status, currentVersion: c.currentVersion,
      cover: c.cover, openRequests: c.openRequests, updatedAt: c.updatedAt, deletedAt: c.deletedAt, url: carouselUrl(c.id),
    })));
  });

  defineTool(server, 'get_carousel', {
    title: 'Get carousel',
    description: 'One carousel: slides JSON and image URLs for a version (default current), version history, requests and studio url. Each slide gets a 1-based "n" field in the output only; do not send "n" back.',
    inputSchema: z.object({ id: Id, version: VersionNo.optional() }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ id, version }) => {
    const got = await store.getCarousel(id, version);
    if (!got) return fail(`carousel ${id} not found`);
    if (!got.version) return fail(`version ${version} not found`);
    return json({
      ...got,
      version: { ...got.version, slides: got.version.slides.map((s, i) => ({ n: i + 1, ...s })) },
      requests: got.requests.map(store.requestOut),
      url: carouselUrl(id),
    });
  });

  defineTool(server, 'create_carousel', {
    title: 'Create carousel',
    description: 'Creates a carousel as version 1 (status review) and renders it to 1080x1350 PNGs. Follow get_brand_guide first. Returns id, version, image URLs and studio url.',
    inputSchema: z.object({
      title: z.string().min(1).describe('Internal title, e.g. "Native date input"'),
      tipNumber: z.number().int().positive().optional().describe('Series number shown on the cover label (e.g. "Tip 014"). Use the next number after the highest existing one.'),
      slides: Slides,
      note: z.string().optional().describe('What this version is.'),
      render: z.boolean().optional().describe('false skips rendering (faster); call render_carousel later'),
    }),
    scope: 'write',
  }, async (args, ctx) => {
    const r = await store.createCarousel({ ...args, createdBy: agentOf(ctx) });
    return json({ ...r, url: carouselUrl(r.id) }, { carouselId: r.id });
  });

  defineTool(server, 'set_carousel_status', {
    title: 'Set carousel status (deprecated)',
    description: 'Deprecated: use update_carousel. Sets draft → review → approved → posted. Only the human approves; agents normally leave status alone.',
    inputSchema: z.object({ id: Id, status: STATUS }),
    scope: 'write',
    annotations: { idempotentHint: true },
    carouselArg: 'id',
  }, async ({ id, status }) => {
    const c = await store.updateCarousel(id, { status });
    return c ? json({ ...c, url: carouselUrl(id) }) : fail(`carousel ${id} not found`);
  });
}
