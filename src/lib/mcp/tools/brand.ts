import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { defineTool, fail, json } from '@/lib/mcp/define';
import { brandGuideText } from '@/lib/mcp/guide';
import { getBrand, resetBrand, roleColor, ROLES, saveBrand, type BrandPack } from '@/lib/brand';

const MAX_FONT_BYTES = 2 * 1024 * 1024;
const isRole = (k: string) => (ROLES as readonly string[]).includes(k);

export function registerBrandTools(server: McpServer) {
  defineTool(server, 'get_brand_guide', {
    title: 'Get brand guide',
    description: 'Agent workflow, slide JSON format and the active brand book. Read once per session before writing or editing slides. Explains scopes, 1-based slide numbers, baseVersion and the trash.',
    inputSchema: z.object({}),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async () => ({ content: [{ type: 'text', text: await brandGuideText() }] }));

  defineTool(server, 'get_brand', {
    title: 'Get brand',
    description: 'The active brand as data: name, handle, labelPrefix, roles (each slide role with its color token and resolved color), color tokens, font families/weights (never the font files) and the brand readme. Use before update_brand or when you need exact colors.',
    inputSchema: z.object({}),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async () => {
    const b = await getBrand({ fresh: true });
    return json({
      name: b.name,
      handle: b.handle,
      labelPrefix: b.labelPrefix,
      roles: Object.fromEntries(ROLES.map(r => [r, { token: b.roles[r] ?? r, color: roleColor(b, r) }])),
      colors: b.tokens.color.tokens.map(t => ({ name: t.name, value: t.value })),
      fonts: b.fonts.map(f => ({ family: f.family, weight: f.weight })),
      readme: b.readme,
    });
  });

  defineTool(server, 'update_brand', {
    title: 'Update brand',
    description: 'Admin. Patches the active brand: any of name, handle, labelPrefix (e.g. "Tip"), readme, and roles (a partial map of slide role to color token name; merged into the existing roles, so unlisted roles keep their mapping). Role names must be valid and token names must exist. Affects all future renders; existing versions keep their images. Idempotent.',
    inputSchema: z.object({
      name: z.string().min(1).optional(),
      handle: z.string().min(1).optional(),
      labelPrefix: z.string().min(1).optional(),
      readme: z.string().optional(),
      roles: z.record(z.string(), z.string()).optional().describe('Partial role to color-token-name map. Valid roles: ' + ROLES.join(', ')),
    }),
    scope: 'admin',
    annotations: { idempotentHint: true },
  }, async patch => {
    if (Object.values(patch).every(v => v === undefined)) return fail('nothing to update: pass at least one of name, handle, labelPrefix, readme, roles');
    if (patch.roles) {
      const badRoles = Object.keys(patch.roles).filter(k => !isRole(k));
      if (badRoles.length) return fail(`unknown role(s): ${badRoles.join(', ')}. Valid roles: ${ROLES.join(', ')}`);
    }
    const cur = await getBrand({ fresh: true });
    let roles = cur.roles;
    if (patch.roles) {
      const names = new Set(cur.tokens.color.tokens.map(t => t.name));
      const bad = Object.entries(patch.roles).filter(([, token]) => !names.has(token)).map(([r, t]) => `${r} -> ${t}`);
      if (bad.length) return fail(`unknown color token(s): ${bad.join(', ')}. Available: ${[...names].join(', ')}`);
      roles = { ...cur.roles, ...patch.roles };
    }
    const next: BrandPack = {
      ...cur,
      name: patch.name ?? cur.name,
      handle: patch.handle ?? cur.handle,
      labelPrefix: patch.labelPrefix ?? cur.labelPrefix,
      readme: patch.readme ?? cur.readme,
      roles,
    };
    await saveBrand(next);
    return json({ name: next.name, handle: next.handle, labelPrefix: next.labelPrefix, roles: next.roles, readmeChars: next.readme.length }, { carouselId: null });
  });

  defineTool(server, 'import_brand', {
    title: 'Import brand',
    description: 'Admin. Replaces the brand tokens (and optionally readme and fonts) from a design-system pack. `tokens` is the tokens.json object and needs color.tokens: [{ name, value }]. `fonts` are woff/woff2 files as { family, weight, base64 }, max 2 MB of base64 in total; they replace the current fonts only if given. Name, handle, label prefix and roles are kept (name follows tokens.name if present); fix roles afterwards with update_brand. For big font sets use the Brand page or `npm run brand:import` instead.',
    inputSchema: z.object({
      tokens: z.record(z.string(), z.unknown()),
      readme: z.string().optional(),
      fonts: z.array(z.object({ family: z.string().min(1), weight: z.string().min(1), base64: z.string().min(1) })).optional(),
    }),
    scope: 'admin',
  }, async ({ tokens, readme, fonts }) => {
    const color = (tokens as { color?: { tokens?: unknown } }).color;
    if (!color || !Array.isArray(color.tokens)) return fail('tokens needs color.tokens: [{ name, value }]');
    let newFonts: BrandPack['fonts'] | undefined;
    if (fonts) {
      const total = fonts.reduce((n, f) => n + f.base64.length, 0);
      if (total > MAX_FONT_BYTES) return fail(`fonts too large: ${total} base64 bytes, limit is ${MAX_FONT_BYTES} (2 MB)`);
      newFonts = [];
      for (const f of fonts) {
        const magic = Buffer.from(f.base64, 'base64').subarray(0, 4).toString('latin1');
        if (magic !== 'wOFF' && magic !== 'wOF2') return fail(`font ${f.family} ${f.weight} is not woff/woff2 (bad magic bytes); only .woff and .woff2 are accepted`);
        newFonts.push({ family: f.family, weight: String(f.weight), data: f.base64 });
      }
    }
    const cur = await getBrand({ fresh: true });
    const next: BrandPack = {
      ...cur,
      name: (tokens as { name?: string }).name ?? cur.name,
      tokens: tokens as BrandPack['tokens'],
      fonts: newFonts?.length ? newFonts : cur.fonts,
      readme: readme ?? cur.readme,
    };
    await saveBrand(next);
    return json({ name: next.name, colors: color.tokens.length, fonts: next.fonts.map(f => ({ family: f.family, weight: f.weight })), fontsReplaced: !!newFonts?.length }, { carouselId: null });
  });

  defineTool(server, 'reset_brand', {
    title: 'Reset brand',
    description: 'Admin, destructive. Deletes the saved brand (including uploaded fonts) and falls back to the bundled default brand. Cannot be undone; fonts are not exportable, so only use this when the human asked for it.',
    inputSchema: z.object({}),
    scope: 'admin',
    annotations: { destructiveHint: true },
  }, async () => {
    await resetBrand();
    const b = await getBrand({ fresh: true });
    return json({ reset: true, activeBrand: b.name }, { carouselId: null });
  });
}
