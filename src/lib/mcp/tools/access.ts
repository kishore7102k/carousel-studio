import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createKey, listKeys, normalizeScopes, revokeKey } from '@/lib/auth';
import { listActivity } from '@/lib/store';
import { defineTool, fail, json, keyIdOf } from '@/lib/mcp/define';
import { Id } from './carousels';

export function registerAccessTools(server: McpServer) {
  defineTool(server, 'list_connections', {
    title: 'List connections',
    description: 'Admin. Lists the API keys (agent connections): id, name, scopes, createdAt, lastUsedAt, and which one is the key you are calling with (`current`). Never returns key secrets. Use before revoke_access.',
    inputSchema: z.object({}),
    scope: 'admin',
    annotations: { readOnlyHint: true },
  }, async (_a, ctx) => {
    const me = keyIdOf(ctx);
    return json((await listKeys()).map(k => ({ ...k, current: k.id === me })));
  });

  defineTool(server, 'create_key', {
    title: 'Create API key',
    description: 'Admin. Creates a new API key for another agent. `scopes`: read (look only), write (read + edit carousels and requests), admin (everything, incl. brand, keys, purge). Higher scopes include lower ones. The secret is returned ONCE in `key`: show it to the human right away, it cannot be retrieved later.',
    inputSchema: z.object({
      name: z.string().trim().min(1).max(60).describe('Agent name shown in the activity log, e.g. "codex".'),
      scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1),
    }),
    scope: 'admin',
  }, async ({ name, scopes }) => {
    const k = await createKey(name, normalizeScopes(scopes));
    return json(k, { carouselId: null, detail: { keyId: k.id, scopes: k.scopes } });
  });

  defineTool(server, 'revoke_access', {
    title: 'Revoke access',
    description: 'Admin, destructive. Permanently deletes an API key (get ids from list_connections); that agent loses access immediately. You cannot revoke the key you are calling with.',
    inputSchema: z.object({ id: Id.describe('API key id from list_connections') }),
    scope: 'admin',
    annotations: { destructiveHint: true },
  }, async ({ id }, ctx) => {
    if (id === keyIdOf(ctx)) return fail('refusing to revoke the key you are calling with; use another admin key or the Agents page');
    const ok = await revokeKey(id);
    return ok ? json({ revoked: true, id }, { carouselId: null }) : fail(`API key ${id} not found`);
  });

  defineTool(server, 'list_activity', {
    title: 'List activity',
    description: 'Recent writes by agents and the human, newest first: actor, action, carouselId, detail, createdAt. Filter by `carouselId`; `limit` default 50, max 200.',
    inputSchema: z.object({
      carouselId: Id.optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    scope: 'read',
    annotations: { readOnlyHint: true },
  }, async ({ carouselId, limit }) => json(await listActivity({ carouselId, limit })));
}
