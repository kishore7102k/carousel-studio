import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { z } from 'zod';
import { getBrand } from '@/lib/brand';
import { verifyApiKey } from '@/lib/auth';
import { Slides, SLIDE_FORMAT_GUIDE } from '@/lib/slides';
import * as store from '@/lib/store';

export const maxDuration = 300;

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });
type Ctx = { http?: { authInfo?: { clientId?: string } } };
const agentOf = (ctx: Ctx) => ctx.http?.authInfo?.clientId ?? 'agent';

const WORKFLOW = `Carousel Studio workflow for agents:
1. Call get_brand_guide once per session and follow it (voice, one marked phrase per slide, limits).
2. list_requests shows what the human asked for: "note" = feedback pinned on a slide (slideIndex, x/y as 0-1 fractions of the image), "new" = make a new carousel from the text.
3. claim_request before working on one (another agent may hold it; leases expire after 30 min).
4. Make the change: update_slides for notes (saves a new version and renders), create_carousel for "new".
5. Optionally view_slides to check the rendered result.
6. complete_request with a one-line reply and the resulting version.`;

const handler = createMcpHandler(server => {
  server.registerTool('get_brand_guide', {
    title: 'Get brand guide',
    description: 'Brand book, slide JSON format and agent workflow. Read once before writing or editing slides.',
    inputSchema: z.object({}),
  }, async () => {
    const b = await getBrand();
    return { content: [{ type: 'text', text: `${WORKFLOW}\n\n# Slide format\n${SLIDE_FORMAT_GUIDE}\n\n# Brand: ${b.name}\nHandle on slides: ${b.handle}. Label: "${b.labelPrefix} 014".\n\n${b.readme}` }] };
  });

  server.registerTool('list_carousels', {
    title: 'List carousels',
    description: 'All carousels, newest first, with status, current version, cover image and open request count.',
    inputSchema: z.object({ status: z.enum(['draft', 'review', 'approved', 'posted']).optional() }),
  }, async ({ status }) => json((await store.listCarousels(status)).map(c => ({ id: c.id, title: c.title, tipNumber: c.tipNumber, status: c.status, currentVersion: c.currentVersion, cover: c.cover, openRequests: c.openRequests, updatedAt: c.updatedAt }))));

  server.registerTool('get_carousel', {
    title: 'Get carousel',
    description: 'One carousel: slides JSON and image URLs for a version (default current), version history and all requests.',
    inputSchema: z.object({ id: z.string().uuid(), version: z.number().int().positive().optional() }),
  }, async ({ id, version }) => {
    const got = await store.getCarousel(id, version);
    return got ? json(got) : fail(`carousel ${id} not found`);
  });

  server.registerTool('create_carousel', {
    title: 'Create carousel',
    description: 'Creates a carousel as version 1 and renders it to 1080x1350 PNGs. Follow the brand guide.',
    inputSchema: z.object({
      title: z.string().min(1).describe('Internal title, e.g. "Native date input"'),
      tipNumber: z.number().int().positive().optional().describe('Series number shown on the cover label (e.g. "Tip 014"). Use the next number after the highest existing one.'),
      slides: Slides,
      note: z.string().optional().describe('What this version is.'),
    }),
  }, async (args, ctx) => json(await store.createCarousel({ ...args, createdBy: agentOf(ctx as Ctx) })));

  server.registerTool('update_slides', {
    title: 'Update slides',
    description: 'Saves the full slides array as a NEW version (old versions are kept) and renders it. Send every slide, not a diff.',
    inputSchema: z.object({ id: z.string().uuid(), slides: Slides, note: z.string().optional().describe('What changed, e.g. "Bigger code on slide 3"') }),
  }, async (args, ctx) => json(await store.updateSlides({ ...args, createdBy: agentOf(ctx as Ctx) })));

  server.registerTool('render_carousel', {
    title: 'Render carousel',
    description: 'Re-renders a version (default current) to PNGs and returns the image URLs.',
    inputSchema: z.object({ id: z.string().uuid(), version: z.number().int().positive().optional() }),
  }, async ({ id, version }) => json(await store.renderCarousel(id, version)));

  server.registerTool('view_slides', {
    title: 'View slides',
    description: 'Returns the rendered slide images so you can check them visually.',
    inputSchema: z.object({ id: z.string().uuid(), version: z.number().int().positive().optional(), slides: z.array(z.number().int().min(1)).optional().describe('1-based slide numbers; default all') }),
  }, async ({ id, version, slides }) => {
    const got = await store.getCarousel(id, version);
    if (!got?.version?.images.length) return fail('no rendered images for that version; call render_carousel first');
    const pick = got.version.images.map((url, i) => ({ url, n: i + 1 })).filter(s => !slides || slides.includes(s.n));
    const images = await Promise.all(pick.map(async s => ({ type: 'image' as const, mimeType: 'image/png', data: Buffer.from(await (await fetch(s.url)).arrayBuffer()).toString('base64') })));
    return { content: [{ type: 'text' as const, text: `Version ${got.version.number}, slides ${pick.map(s => s.n).join(', ')}` }, ...images] };
  });

  server.registerTool('set_carousel_status', {
    title: 'Set carousel status',
    description: 'draft → review → approved → posted. Only the human approves; agents normally leave status alone.',
    inputSchema: z.object({ id: z.string().uuid(), status: z.enum(['draft', 'review', 'approved', 'posted']) }),
  }, async ({ id, status }) => json(await store.updateCarousel(id, { status })));

  server.registerTool('list_requests', {
    title: 'List requests',
    description: 'The human\'s queue: notes pinned on slides and new-carousel prompts. Default: open and claimed.',
    inputSchema: z.object({ status: z.enum(['active', 'open', 'claimed', 'done', 'dismissed']).optional(), carouselId: z.string().uuid().optional() }),
  }, async args => json(await store.listRequests(args)));

  server.registerTool('claim_request', {
    title: 'Claim request',
    description: 'Locks a request for you for 30 minutes so other agents skip it. Fails if another agent holds it.',
    inputSchema: z.object({ id: z.string().uuid() }),
  }, async ({ id }, ctx) => {
    const r = await store.claimRequest(id, agentOf(ctx as Ctx));
    return r ? json(r) : fail('request is held by another agent or already done');
  });

  server.registerTool('complete_request', {
    title: 'Complete request',
    description: 'Marks a request done with a short reply the human will read.',
    inputSchema: z.object({
      id: z.string().uuid(),
      reply: z.string().min(1).describe('One line: what you changed.'),
      resultVersion: z.number().int().positive().optional().describe('Version created by the change.'),
      carouselId: z.string().uuid().optional().describe('For "new" requests: the carousel you created.'),
    }),
  }, async ({ id, reply, resultVersion, carouselId }, ctx) => {
    const r = await store.completeRequest(id, agentOf(ctx as Ctx), reply, resultVersion, carouselId);
    return r ? json(r) : fail(`request ${id} not found`);
  });
}, { serverInfo: { name: 'carousel-studio', version: '0.1.0' } });

const authed = withMcpAuth(handler, async (_req, token) => {
  const agent = await verifyApiKey(token);
  return agent ? { token: token!, clientId: agent.name, scopes: agent.scopes, extra: { keyId: agent.id } } : undefined;
}, { required: true });

export { authed as GET, authed as POST, authed as DELETE };
