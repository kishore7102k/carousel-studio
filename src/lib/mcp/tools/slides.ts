import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Slides } from '@/lib/slides';
import * as store from '@/lib/store';
import { agentOf, carouselUrl, defineTool, json } from '@/lib/mcp/define';
import { Id, VersionNo } from './carousels';

export const editOpts = {
  note: z.string().optional().describe('What changed, e.g. "Bigger code on slide 3"'),
  baseVersion: VersionNo.optional().describe('The version you read. If the carousel has moved on, the call fails with "stale: current version is N".'),
  render: z.boolean().optional().describe('false skips rendering; call render_carousel later'),
};

export function registerSlideTools(server: McpServer) {
  defineTool(server, 'update_slides', {
    title: 'Update slides',
    description: 'Replaces ALL slides: saves the full array as a NEW version from the current one (old versions are kept) and renders it. Send every slide, not a diff; for one-slide changes prefer edit_slide / insert_slide / remove_slide / move_slide.',
    inputSchema: z.object({ id: Id, slides: Slides, ...editOpts }),
    scope: 'write',
    carouselArg: 'id',
  }, async (args, ctx) => {
    const r = await store.updateSlides({ ...args, createdBy: agentOf(ctx) });
    return json({ ...r, url: carouselUrl(args.id) });
  });
}
