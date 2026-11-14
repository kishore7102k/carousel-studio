import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Slide, Slides } from '@/lib/slides';
import * as store from '@/lib/store';
import { agentOf, carouselUrl, defineTool, fail, json } from '@/lib/mcp/define';
import { Id, VersionNo } from './carousels';

export const editOpts = {
  note: z.string().optional().describe('What changed, e.g. "Bigger code on slide 3"'),
  baseVersion: VersionNo.optional().describe('The version you read. If the carousel has moved on, the call fails with "stale: current version is N"; re-read with get_carousel and retry.'),
  render: z.boolean().optional().describe('false skips rendering; call render_carousel later'),
};

const SlideNo = z.number().int().min(1);

/** Common output of every slide edit. */
const out = (id: string, r: Awaited<ReturnType<typeof store.modifySlides>>, extra: Record<string, unknown> = {}) => ({
  id,
  version: r.version,
  previousVersion: r.previousVersion,
  ...(r.unchanged ? { unchanged: true } : {}),
  slideCount: r.slides.length,
  ...extra,
  images: r.images,
  url: carouselUrl(id),
});

const COMMON = 'Creates a NEW version from the CURRENT version (old versions are kept, status goes back to review) and renders it. Slide numbers are 1-based. Refused on trashed carousels. Pass baseVersion (the version you read) to fail with "stale" instead of editing a version someone else just replaced.';

export function registerSlideTools(server: McpServer) {
  defineTool(server, 'update_slides', {
    title: 'Update slides',
    description: 'Replaces ALL slides: saves the full array as a NEW version from the current one (old versions are kept) and renders it. Send every slide, not a diff; for one-slide changes prefer edit_slide / insert_slide / remove_slide / move_slide. Pass baseVersion to fail with "stale" if someone else changed the carousel since you read it.',
    inputSchema: z.object({ id: Id, slides: Slides, ...editOpts }),
    scope: 'write',
    carouselArg: 'id',
  }, async (args, ctx) => {
    const r = await store.updateSlides({ ...args, createdBy: agentOf(ctx) });
    return json({ ...r, url: carouselUrl(args.id) }, { detail: { version: r.version } });
  });

  defineTool(server, 'edit_slide', {
    title: 'Edit one slide',
    description: `Changes fields of ONE slide by shallow-merging \`patch\` into slide n: given fields replace the old values, omitted fields stay, and a field set to null is removed (e.g. { "sub": null }). Arrays like "points" are replaced whole. Changing "kind" is allowed only if the result is a valid slide of the new kind (send its required fields too); fields the new kind does not have are dropped and listed in "dropped". ${COMMON} Returns the edited slide.`,
    inputSchema: z.object({
      id: Id,
      slide: SlideNo.describe('1-based slide number'),
      patch: z.record(z.string(), z.unknown()).describe('Fields to set, e.g. { "title": "New *title*" } or { "points": ["a", "b"] }; null removes a field. See get_brand_guide for the fields of each kind.'),
      ...editOpts,
    }),
    scope: 'write',
    carouselArg: 'id',
  }, async (args, ctx) => {
    if (!Object.keys(args.patch).length) return fail('empty patch: send at least one field');
    const r = await store.editSlide({ ...args, createdBy: agentOf(ctx) });
    return json(
      out(args.id, r, { slide: { n: args.slide, ...r.slides[args.slide - 1] }, ...(r.dropped.length ? { dropped: r.dropped } : {}) }),
      { detail: { slide: args.slide, version: r.version } },
    );
  });

  defineTool(server, 'insert_slide', {
    title: 'Insert slide',
    description: `Inserts one new slide BEFORE position \`at\` (1-based); at = slide count + 1 appends at the end. Max 10 slides. ${COMMON}`,
    inputSchema: z.object({
      id: Id,
      at: SlideNo.describe('1-based position the new slide will have; count+1 appends'),
      slide: Slide,
      ...editOpts,
    }),
    scope: 'write',
    carouselArg: 'id',
  }, async (args, ctx) => {
    const r = await store.insertSlide({ ...args, createdBy: agentOf(ctx) });
    return json(out(args.id, r, { inserted: args.at }), { detail: { at: args.at, kind: args.slide.kind, version: r.version } });
  });

  defineTool(server, 'remove_slide', {
    title: 'Remove slide',
    description: `Removes slide n. Refused if fewer than 2 slides would remain. The removed slide stays in the previous version (set_current_version rolls back). ${COMMON}`,
    inputSchema: z.object({ id: Id, slide: SlideNo.describe('1-based slide number'), ...editOpts }),
    scope: 'write',
    annotations: { destructiveHint: true },
    carouselArg: 'id',
  }, async (args, ctx) => {
    const r = await store.removeSlide({ ...args, createdBy: agentOf(ctx) });
    return json(out(args.id, r, { removed: { n: args.slide, ...r.removed } }), { detail: { slide: args.slide, version: r.version } });
  });

  defineTool(server, 'move_slide', {
    title: 'Move slide',
    description: `Moves slide \`from\` so it ends up at position \`to\` (both 1-based; other slides shift). ${COMMON}`,
    inputSchema: z.object({ id: Id, from: SlideNo, to: SlideNo, ...editOpts }),
    scope: 'write',
    carouselArg: 'id',
  }, async (args, ctx) => {
    if (args.from === args.to) return fail('from and to are the same; nothing to move');
    const r = await store.moveSlide({ ...args, createdBy: agentOf(ctx) });
    return json(out(args.id, r, { moved: { from: args.from, to: args.to } }), { detail: { version: r.version } });
  });
}
