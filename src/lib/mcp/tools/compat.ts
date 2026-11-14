import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { defineTool, fail, json } from '@/lib/mcp/define';
import { brandGuideText } from '@/lib/mcp/guide';
import { fetchStudio, searchStudio } from '@/lib/search';

const user = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

export function registerCompatTools(server: McpServer) {
  // OpenAI-style connectors (ChatGPT deep research) expect exactly `search` and `fetch`.
  defineTool(server, 'search', {
    title: 'Search studio',
    description: 'Free-text search over carousel titles, the slide text of each carousel\'s current version, and request text (trashed carousels excluded). Returns { results: [{ id, title, url }] } with ids like "carousel:<uuid>" or "request:<uuid>"; pass an id to `fetch`. For filtering by status use list_carousels instead.',
    inputSchema: z.object({ query: z.string().min(1) }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ query }) => json({ results: await searchStudio(query) }));

  defineTool(server, 'fetch', {
    title: 'Fetch studio item',
    description: 'Reads one item returned by `search`: id "carousel:<uuid>" gives the readable slide text of the current version, "request:<uuid>" gives the request text. Returns { id, title, text, url, metadata }. For structured slide JSON use get_carousel.',
    inputSchema: z.object({ id: z.string().min(1).describe('carousel:<uuid> or request:<uuid>') }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    const r = await fetchStudio(id);
    return r ? json(r) : fail(`nothing found for id "${id}". Ids look like carousel:<uuid> or request:<uuid>.`);
  });

  server.registerResource('brand-guide', 'studio://brand-guide', {
    title: 'Brand guide',
    description: 'Agent workflow, slide format and the active brand book (same text as the get_brand_guide tool).',
    mimeType: 'text/markdown',
  }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await brandGuideText() }] }));

  server.registerPrompt('make_carousel', {
    title: 'Make a carousel',
    description: 'Write and save a 5-8 slide carousel on a topic, following the brand guide.',
    argsSchema: z.object({ topic: z.string() }),
  }, async ({ topic }) => user(
    `Make a carousel about: ${topic}\n\n1. Read the brand guide first (get_brand_guide or the studio://brand-guide resource) and follow its voice and limits.\n2. Draft 5 to 8 slides: a cover with a hook (one *marked* phrase), content/code slides with one idea each, and a closing cta slide.\n3. Save it with create_carousel, then check the rendered result with view_slides and fix anything that overflows with edit_slide.\n4. Reply with the carousel link. Leave the status for the human.`,
  ));

  server.registerPrompt('handle_requests', {
    title: 'Handle requests',
    description: 'Work through the open requests in the queue: claim, fix, complete.',
  }, async () => user(
    `Work through the open requests in Carousel Studio.\n\n1. Read the brand guide (get_brand_guide) once.\n2. list_requests to see what is open. For each request: claim_request, then read the carousel with get_carousel (slide numbers are 1-based).\n3. Make the change with edit_slide / insert_slide / remove_slide / move_slide (pass baseVersion), or create_carousel for "new" requests. Check the result with view_slides.\n4. complete_request with a one-line reply and the resulting version, or dismiss_request if it should not be done.\n5. Stop when list_requests is empty and summarise what you changed.`,
  ));
}
