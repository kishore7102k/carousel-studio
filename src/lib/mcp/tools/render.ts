import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import * as store from '@/lib/store';
import { carouselUrl, defineTool, fail, json } from '@/lib/mcp/define';
import { Id, VersionNo } from './carousels';

export function registerRenderTools(server: McpServer) {
  defineTool(server, 'render_carousel', {
    title: 'Render carousel',
    description: 'Re-renders a version (default current) to PNGs and returns the image URLs. Use after render: false, or to refresh images after a brand change.',
    inputSchema: z.object({ id: Id, version: VersionNo.optional() }),
    scope: 'write',
    annotations: { idempotentHint: true },
    carouselArg: 'id',
  }, async ({ id, version }) => json({ ...(await store.renderCarousel(id, version)), url: carouselUrl(id) }));

  defineTool(server, 'view_slides', {
    title: 'View slides',
    description: 'Returns the rendered PNGs of a version (default current) as images for visual review, plus their URLs as text for clients that do not display MCP images. Call render_carousel first if nothing is rendered.',
    inputSchema: z.object({
      id: Id,
      version: VersionNo.optional(),
      slides: z.array(z.number().int().min(1)).optional().describe('1-based slide numbers; default all'),
    }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ id, version, slides }) => {
    const got = await store.getCarousel(id, version);
    if (!got) return fail(`carousel ${id} not found`);
    if (!got.version?.images.length) return fail('no rendered images for that version; call render_carousel first');
    const pick = got.version.images.map((url, i) => ({ url, n: i + 1 })).filter(s => !slides || slides.includes(s.n));
    if (!pick.length) return fail(`no such slides; this version has ${got.version.images.length}`);
    const images = await Promise.all(pick.map(async s => {
      const res = await fetch(s.url);
      if (!res.ok) throw new Error(`could not load slide ${s.n} image (${res.status})`);
      return { type: 'image' as const, mimeType: 'image/png', data: Buffer.from(await res.arrayBuffer()).toString('base64') };
    }));
    const text = `Version ${got.version.number}, slides ${pick.map(s => s.n).join(', ')}\n\nImage URLs:\n${pick.map(s => `${s.n}. ${s.url}`).join('\n')}`;
    return { content: [{ type: 'text', text }, ...images] };
  });

  defineTool(server, 'get_download_links', {
    title: 'Get download links',
    description: 'Public PNG URLs (1080x1350) of a version (default current) in slide order, with file names 01.png, 02.png… to save them under. Use it to hand the final images to a publishing step or the user. Fails if the version is not rendered; call render_carousel first.',
    inputSchema: z.object({ id: Id, version: VersionNo.optional() }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ id, version }) => {
    const got = await store.getCarousel(id, version);
    if (!got) return fail(`carousel ${id} not found`);
    if (!got.version) return fail(`version ${version} not found`);
    const { number, images, slides } = got.version;
    if (!images.length) return fail(`version ${number} is not rendered; call render_carousel first`);
    return json({
      id,
      title: got.carousel.title,
      version: number,
      ...(images.length !== slides.length ? { warning: `images (${images.length}) do not match slides (${slides.length}); call render_carousel` } : {}),
      files: images.map((url, i) => ({ n: i + 1, name: `${String(i + 1).padStart(2, '0')}.png`, url })),
      url: carouselUrl(id),
    });
  });
}
