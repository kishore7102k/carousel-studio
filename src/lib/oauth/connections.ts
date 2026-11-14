// "Connected apps": OAuth clients that currently hold at least one live token. Used by the Agents page and the access tools.
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { SCOPES } from './core';

export type ConnectedApp = {
  /** oauth_clients row id (what disconnectClient takes). */
  id: string;
  /** The OAuth client_id (DCR id, or the metadata URL for CIMD clients). */
  clientId: string;
  name: string;
  redirectHost: string;
  source: 'dcr' | 'cimd';
  scopes: string[];
  connectedAt: Date;
  lastUsedAt: Date | null;
};

const hostOf = (uri: string | undefined) => {
  if (!uri) return '';
  try { return new URL(uri).host; } catch { return ''; }
};

/** OAuth clients holding at least one live (not revoked, not expired) token; refresh tokens count. */
export async function listConnectedApps(): Promise<ConnectedApp[]> {
  const db = getDb();
  const tokens = await db.select().from(schema.oauthTokens)
    .where(and(isNull(schema.oauthTokens.revokedAt), gt(schema.oauthTokens.expiresAt, new Date())));
  if (!tokens.length) return [];
  const clientIds = [...new Set(tokens.map(t => t.clientId))];
  const clients = await db.select().from(schema.oauthClients).where(inArray(schema.oauthClients.clientId, clientIds));
  const apps: ConnectedApp[] = [];
  for (const c of clients) {
    const mine = tokens.filter(t => t.clientId === c.clientId);
    const scopes = SCOPES.filter(s => mine.some(t => t.scopes.includes(s)));
    const used = mine.map(t => t.lastUsedAt).filter((d): d is Date => !!d);
    apps.push({
      id: c.id,
      clientId: c.clientId,
      name: c.name,
      redirectHost: hostOf(c.redirectUris[0]),
      source: c.source,
      scopes,
      connectedAt: new Date(Math.min(...mine.map(t => t.createdAt.getTime()))),
      lastUsedAt: used.length ? new Date(Math.max(...used.map(d => d.getTime()))) : (c.lastUsedAt ?? null),
    });
  }
  return apps.sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime());
}

/** Revokes every live token of the client (row id); keeps the client record. Returns how many tokens were revoked. */
export async function disconnectClient(id: string): Promise<number> {
  const db = getDb();
  const [client] = await db.select({ clientId: schema.oauthClients.clientId }).from(schema.oauthClients).where(eq(schema.oauthClients.id, id));
  if (!client) return 0;
  const rows = await db.update(schema.oauthTokens).set({ revokedAt: new Date() })
    .where(and(eq(schema.oauthTokens.clientId, client.clientId), isNull(schema.oauthTokens.revokedAt)))
    .returning({ id: schema.oauthTokens.id });
  return rows.length;
}
