import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SlideInputs, type Slide } from '@/lib/slides';
import { resolveSlideInputs } from '@/lib/layouts';
import * as store from '@/lib/store';
import { selfCheck } from '@/lib/previews';
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
    description: 'One carousel: slides JSON, image URLs and per-slide lint ({ errors, warnings } for design slides, null for legacy template slides) for a version (default current), version history, requests and studio url. Each slide gets a 1-based "n" field in the output only; do not send "n" back.',
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
    description: 'Creates a carousel as version 1 (status review) and renders it to 1080x1350 PNGs. Follow get_brand_guide first. Every slide is designed by you in HTML/CSS ({ kind: "design", html, css? }) or comes from a saved layout ({ kind: "design", layout, fill }); there are no templates. Pick a visual concept for the carousel first and vary the layouts (see get_brand_guide "Designing slides"). Design slides are sanitized and checked: off-canvas content refuses the save; other findings come back as per-slide "warnings". Returns id, version, image URLs, warnings and studio url.',
    inputSchema: z.object({
      title: z.string().min(1).describe('Internal title, e.g. "Native date input"'),
      tipNumber: z.number().int().positive().optional().describe('Series number shown on the cover label (e.g. "Tip 014"). Use the next number after the highest existing one.'),
      slides: SlideInputs,
      note: z.string().optional().describe('What this version is.'),
      render: z.boolean().optional().describe('false skips rendering (faster); call render_carousel later'),
    }),
    scope: 'write',
  }, async (args, ctx) => {
    const slides = (await resolveSlideInputs(args.slides)) as Slide[];
    const r = await store.createCarousel({ ...args, slides, createdBy: agentOf(ctx) });
    const check = await selfCheck(agentOf(ctx), slides);
    return json({ ...r, ...(check ? { selfCheck: check } : {}), url: carouselUrl(r.id) }, { carouselId: r.id });
  });

  defineTool(server, 'update_carousel', {
    title: 'Update carousel',
    description: 'Patches carousel metadata: `title`, `number` (the tip number on the cover label; null clears it) and `status` (draft → review → approved → posted; only the human approves, agents normally leave status alone). Does not touch slides or create a version; use the slide tools for content. Send at least one field.',
    inputSchema: z.object({
      id: Id,
      title: z.string().trim().min(1).optional(),
      number: z.number().int().positive().nullable().optional().describe('Tip number shown on the cover label, e.g. 14 → "Tip 014". null clears it. Re-render to update the images.'),
      status: STATUS.optional(),
    }),
    scope: 'write',
    annotations: { idempotentHint: true },
    carouselArg: 'id',
  }, async ({ id, title, number, status }) => {
    const patch = {
      ...(title !== undefined ? { title } : {}),
      ...(number !== undefined ? { tipNumber: number } : {}),
      ...(status !== undefined ? { status } : {}),
    };
    if (!Object.keys(patch).length) return fail('nothing to update: send title, number or status');
    const c = await store.updateCarousel(id, patch);
    return c ? json({ ...c, url: carouselUrl(id) }) : fail(`carousel ${id} not found`);
  });

  defineTool(server, 'duplicate_carousel', {
    title: 'Duplicate carousel',
    description: 'Copies one version (default current) of a carousel into a NEW carousel as its version 1 (status review, same tip number) and renders it. The original is unchanged. Use it to start a variant or a follow-up post from an existing one. Returns the new id, version, images and url.',
    inputSchema: z.object({
      id: Id.describe('Carousel to copy'),
      version: VersionNo.optional().describe('Version to copy (default current)'),
      title: z.string().trim().min(1).optional().describe('Title of the copy (default "<title> (copy)")'),
      render: z.boolean().optional().describe('false skips rendering; call render_carousel later'),
    }),
    scope: 'write',
  }, async (args, ctx) => {
    const r = await store.duplicateCarousel({ ...args, createdBy: agentOf(ctx) });
    return json({ ...r, copiedFrom: args.id, url: carouselUrl(r.id) }, { carouselId: r.id });
  });

  defineTool(server, 'delete_carousel', {
    title: 'Delete carousel (to trash)',
    description: 'Moves a carousel to the trash (soft delete). It disappears from list_carousels but keeps all versions and images; restore_carousel undoes it. Calling it on a trashed carousel is a no-op. Permanent deletion is purge_carousel (admin).',
    inputSchema: z.object({ id: Id }),
    scope: 'write',
    annotations: { destructiveHint: true },
    carouselArg: 'id',
  }, async ({ id }) => {
    const c = await store.deleteCarousel(id);
    return c
      ? json({ id, title: c.title, deletedAt: c.deletedAt, url: carouselUrl(id), undo: 'restore_carousel' })
      : fail(`carousel ${id} not found`);
  });

  defineTool(server, 'restore_carousel', {
    title: 'Restore carousel',
    description: 'Takes a carousel out of the trash (clears deleted_at). Safe to call on a carousel that is not trashed.',
    inputSchema: z.object({ id: Id }),
    scope: 'write',
    annotations: { idempotentHint: true },
    carouselArg: 'id',
  }, async ({ id }) => {
    const c = await store.restoreCarousel(id);
    return c ? json({ ...c, url: carouselUrl(id) }) : fail(`carousel ${id} not found`);
  });

  defineTool(server, 'purge_carousel', {
    title: 'Purge carousel (permanent)',
    description: 'PERMANENTLY deletes a carousel, all its versions, requests and rendered images. Cannot be undone. Only works on a carousel already in the trash (delete_carousel first); otherwise it fails. Requires the admin scope.',
    inputSchema: z.object({ id: Id }),
    scope: 'admin',
    annotations: { destructiveHint: true },
  }, async ({ id }) => {
    const r = await store.purgeCarousel(id);
    // The row is gone, so the activity row cannot reference it; keep the id in detail.
    return json(r, { carouselId: null, detail: { id, title: r.title, blobsDeleted: r.blobsDeleted } });
  });

  defineTool(server, 'set_current_version', {
    title: 'Set current version',
    description: 'Points the carousel at an existing version (e.g. roll back to v2). No new version is created and nothing is re-rendered; the version keeps its own images. get_carousel lists the versions.',
    inputSchema: z.object({ id: Id, version: VersionNo }),
    scope: 'write',
    annotations: { idempotentHint: true },
    carouselArg: 'id',
  }, async ({ id, version }) => {
    const c = await store.setCurrentVersion(id, version);
    return json({ ...c, url: carouselUrl(id) });
  });

  defineTool(server, 'compare_versions', {
    title: 'Compare versions',
    description: 'Diffs two versions of a carousel slide by slide (by position, 1-based): each entry is "added", "removed" or "changed" with the changed fields as { from, to }. Unchanged slides are omitted. Use it to see what another agent or the human changed.',
    inputSchema: z.object({ id: Id, a: VersionNo.describe('Older version'), b: VersionNo.describe('Newer version') }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ id, a, b }) => json({ ...(await store.compareVersions(id, a, b)), url: carouselUrl(id) }));

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
