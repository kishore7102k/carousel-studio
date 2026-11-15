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
    description: 'Design and save a 5-8 slide carousel on a topic: your own visual concept and layouts on the brand system (no templates).',
    argsSchema: z.object({ topic: z.string() }),
  }, async ({ topic }) => user(
    `Design a carousel about: ${topic}\n\n1. Read the brand guide first (get_brand_guide or the studio://brand-guide resource), especially "Designing slides": the brand gives you colors, fonts and voice, not layouts. get_design_system lists the CSS variables and classes.\n2. Think before designing: the one takeaway, the story arc across 5 to 8 slides, a visual concept AND a palette for this carousel (write both in the first slide's notes; do not default to the brand green, and do not reuse another carousel's colors). Choose each slide's layout from its content and vary layouts between slides; do not fall back on a "label + hook, title + bullet list, code card, closing line" formula, and do not add a footer, a highlighted phrase, kicker labels or keycaps to every slide by habit. Show the handle once or twice where it fits.\n3. Build every slide as { kind: "design", html, css }. preview_slide each one, look at the image critically (hierarchy, balance, empty space, contrast), fix warnings and weak spots, and preview again.\n4. Run the MANDATORY self-check from the guide ("Before you save") on every slide's final preview image: phone readability, balance, hierarchy, palette, variety, no default decorations, copy. Fix and re-preview until every answer is yes, and note "self-check: ok" in each slide's notes.\n5. Save with create_carousel. If the response has "selfCheck", some slides were not previewed in their final form: preview them, look, fix with edit_slide. Then check the result with view_slides.\n6. Reply with the carousel link and one line on the concept. Leave the status for the human.`,
  ));

  server.registerPrompt('handle_requests', {
    title: 'Handle requests',
    description: 'Work through the open requests in the queue: claim, fix, complete.',
  }, async () => user(
    `Work through the open requests in Carousel Studio.\n\n1. Read the brand guide (get_brand_guide) once.\n2. list_requests to see what is open. For each request: claim_request, then read the carousel with get_carousel (slide numbers are 1-based).\n3. Make the change with edit_slide / insert_slide / remove_slide / move_slide (pass baseVersion), designing slides yourself (no templates; preview_slide before saving), or design a whole carousel with create_carousel for "new" requests. Check the result with view_slides.\n4. complete_request with a one-line reply and the resulting version, or dismiss_request if it should not be done.\n5. Stop when list_requests is empty and summarise what you changed.`,
  ));
}
