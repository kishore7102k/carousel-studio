import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import * as store from '@/lib/store';
import { agentOf, carouselUrl, defineTool, fail, json } from '@/lib/mcp/define';
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

  defineTool(server, 'get_request', {
    title: 'Get request',
    description: 'One request by id with its carousel title and studio url (if it has a carousel). Use after list_requests to read a single item in full.',
    inputSchema: z.object({ id: Id }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    const r = await store.getRequest(id);
    if (!r) return fail(`request ${id} not found`);
    const c = r.carouselId ? (await store.getCarousel(r.carouselId))?.carousel : null;
    return json({ ...store.requestOut(r), carouselTitle: c?.title ?? null, carouselUrl: r.carouselId ? carouselUrl(r.carouselId) : null });
  });

  defineTool(server, 'add_note', {
    title: 'Add note',
    description: 'Pins a note on a slide, creating an open "note" request (feedback for yourself or another agent to act on). `slide` is 1-based and must exist in the version. x/y are 0-1 fractions of the image (default 0.5 = center). `version` defaults to the current version.',
    inputSchema: z.object({
      carouselId: Id,
      slide: z.number().int().positive().describe('1-based slide number'),
      text: z.string().min(1),
      x: z.number().min(0).max(1).optional(),
      y: z.number().min(0).max(1).optional(),
      version: VersionNo.optional(),
    }),
    scope: 'write',
    carouselArg: 'carouselId',
  }, async ({ carouselId, slide, text, x, y, version }) => {
    const data = await store.getCarousel(carouselId, version);
    if (!data) return fail(`carousel ${carouselId} not found`);
    if (!data.version) return fail(`version ${version ?? data.carousel.currentVersion} not found`);
    const n = data.version.slides.length;
    if (slide > n) return fail(`slide ${slide} does not exist: version ${data.version.number} has ${n} slides`);
    const r = await store.addRequest({ kind: 'note', text, carouselId, versionNumber: data.version.number, slideIndex: slide - 1, x: x ?? 0.5, y: y ?? 0.5 });
    return json(store.requestOut(r));
  });

  defineTool(server, 'request_carousel', {
    title: 'Request a carousel',
    description: 'Adds an open "new" request: a prompt asking for a new carousel, to be picked up with claim_request and finished with create_carousel + complete_request. Use to queue work for yourself or another agent.',
    inputSchema: z.object({ prompt: z.string().min(1) }),
    scope: 'write',
  }, async ({ prompt }) => {
    const r = await store.addRequest({ kind: 'new', text: prompt });
    return json(store.requestOut(r), { carouselId: null });
  });

  defineTool(server, 'dismiss_request', {
    title: 'Dismiss request',
    description: 'Marks an open or claimed request dismissed (it will not be done). Idempotent: an already dismissed request is returned unchanged. Done requests cannot be dismissed. Undo with reopen_request.',
    inputSchema: z.object({ id: Id }),
    scope: 'write',
    annotations: { idempotentHint: true },
  }, async ({ id }) => {
    const { row, changed } = await store.dismissRequest(id);
    if (!row) return fail(`request ${id} not found`);
    if (!changed && row.status !== 'dismissed') return fail(`request is ${row.status}; only open or claimed requests can be dismissed`);
    return json(store.requestOut(row), { carouselId: row.carouselId });
  });

  defineTool(server, 'reopen_request', {
    title: 'Reopen request',
    description: 'Puts a done or dismissed request back to open and clears its claim, reply and resultVersion. Idempotent: an already open request is returned unchanged.',
    inputSchema: z.object({ id: Id }),
    scope: 'write',
    annotations: { idempotentHint: true },
  }, async ({ id }) => {
    const { row, changed } = await store.reopenRequest(id);
    if (!row) return fail(`request ${id} not found`);
    if (!changed && row.status !== 'open') return fail(`request is ${row.status}; only done or dismissed requests can be reopened`);
    return json(store.requestOut(row), { carouselId: row.carouselId });
  });
}
