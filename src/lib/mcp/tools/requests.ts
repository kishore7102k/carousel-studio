import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import * as store from '@/lib/store';
import { agentOf, defineTool, fail, json } from '@/lib/mcp/define';
import { Id, VersionNo } from './carousels';

export function registerRequestTools(server: McpServer) {
  defineTool(server, 'list_requests', {
    title: 'List requests',
    description: 'The human\'s queue: notes pinned on slides ("note", with 1-based `slide` and x/y 0-1) and new-carousel prompts ("new"). Default status "active" = open + claimed.',
    inputSchema: z.object({
      status: z.enum(['active', 'open', 'claimed', 'done', 'dismissed']).optional(),
      carouselId: Id.optional(),
    }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async args => json((await store.listRequests(args)).map(store.requestOut)));

  defineTool(server, 'claim_request', {
    title: 'Claim request',
    description: 'Locks a request for you for 30 minutes so other agents skip it. Fails if another agent holds it or it is done/dismissed. Re-claiming your own request refreshes the lease.',
    inputSchema: z.object({ id: Id }),
    scope: 'write',
    annotations: { idempotentHint: true },
  }, async ({ id }, ctx) => {
    const r = await store.claimRequest(id, agentOf(ctx));
    return r ? json(store.requestOut(r), { carouselId: r.carouselId }) : fail('request is held by another agent, already done/dismissed, or not found');
  });

  defineTool(server, 'complete_request', {
    title: 'Complete request',
    description: 'Marks a request done with a short reply the human will read. Pass the version your change created, and for "new" requests the carousel you created.',
    inputSchema: z.object({
      id: Id,
      reply: z.string().min(1).describe('One line: what you changed.'),
      resultVersion: VersionNo.optional().describe('Version created by the change.'),
      carouselId: Id.optional().describe('For "new" requests: the carousel you created.'),
    }),
    scope: 'write',
  }, async ({ id, reply, resultVersion, carouselId }, ctx) => {
    const r = await store.completeRequest(id, agentOf(ctx), reply, resultVersion, carouselId);
    return r ? json(store.requestOut(r), { carouselId: r.carouselId }) : fail(`request ${id} not found`);
  });
}
