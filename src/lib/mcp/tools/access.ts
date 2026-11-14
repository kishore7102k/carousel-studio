import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createKey, listKeys, normalizeScopes, revokeKey } from '@/lib/auth';
import { listActivity } from '@/lib/store';
import { disconnectClient, listConnectedApps } from '@/lib/oauth/connections';
import { defineTool, fail, json, keyIdOf, type McpCtx } from '@/lib/mcp/define';
import { Id } from './carousels';

const oauthClientOf = (ctx: McpCtx): string | null => {
  const id = ctx.http?.authInfo?.extra?.oauthClientId;
  return typeof id === 'string' ? id : null;
};

export function registerAccessTools(server: McpServer) {
  defineTool(server, 'list_connections', {
    title: 'List connections',
    description: 'Admin. Lists everything that can access the studio, as `{ apiKeys, oauthApps }`. `apiKeys`: header keys (id, name, scopes, createdAt, lastUsedAt). `oauthApps`: web apps connected via OAuth, e.g. ChatGPT or Claude.ai (id, name, redirectHost, source, scopes, connectedAt, lastUsedAt). Each entry has `current: true` when it is the connection you are calling with. Never returns secrets. Use before revoke_access.',
    inputSchema: z.object({}),
    scope: 'admin',
    annotations: { readOnlyHint: true },
  }, async (_a, ctx) => {
    const me = keyIdOf(ctx);
    const meApp = oauthClientOf(ctx);
    const [keys, apps] = await Promise.all([listKeys(), listConnectedApps()]);
    return json({
      apiKeys: keys.map(k => ({ ...k, current: k.id === me })),
      oauthApps: apps.map(({ clientId, ...a }) => ({ ...a, current: !!meApp && (a.id === meApp || clientId === meApp) })),
    });
  });

  defineTool(server, 'create_key', {
    title: 'Create API key',
    description: 'Admin. Creates a new API key (header bearer token, API keys only; OAuth apps connect via the Agents page instructions) for another agent. `scopes`: read (look only), write (read + edit carousels and requests), admin (everything, incl. brand, keys, purge). Higher scopes include lower ones. The secret is returned ONCE in `key`: show it to the human right away, it cannot be retrieved later.',
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
    description: 'Admin, destructive. Cuts off a connection by `id` from list_connections: an API key id is permanently deleted, an OAuth app id is disconnected (all its tokens revoked; the user can reconnect later). Access ends immediately. You cannot revoke the connection you are calling with.',
    inputSchema: z.object({ id: Id.describe('API key id or connected app id from list_connections') }),
    scope: 'admin',
    annotations: { destructiveHint: true },
  }, async ({ id }, ctx) => {
    if (id === keyIdOf(ctx)) return fail('refusing to revoke the key you are calling with; use another admin key or the Agents page');
    const app = (await listConnectedApps()).find(a => a.id === id);
    if (app) {
      const me = oauthClientOf(ctx);
      if (me && (app.id === me || app.clientId === me)) return fail('refusing to disconnect the app you are calling with; use another admin connection or the Agents page');
      const tokens = await disconnectClient(id);
      return json({ disconnected: true, id, name: app.name, tokensRevoked: tokens }, { carouselId: null, detail: { appId: id, name: app.name } });
    }
    const ok = await revokeKey(id);
    return ok ? json({ revoked: true, id }, { carouselId: null }) : fail(`No API key or connected app with id ${id}`);
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
