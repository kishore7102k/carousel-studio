// OAuth clients: registered via DCR (source 'dcr') or described by a Client ID Metadata Document URL (source 'cimd').
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';

export type OAuthClient = typeof schema.oauthClients.$inferSelect;

/**
 * The client for a `client_id`: a registered (DCR) client, or — when client_id is an https URL — its
 * metadata document (fetched SSRF-safely and cached 24 h). null when unknown or the document is invalid.
 * Phase 2 item 5 adds the CIMD branch; today this only finds registered clients.
 */
export async function resolveClient(clientId: string): Promise<OAuthClient | null> {
  const [c] = await getDb().select().from(schema.oauthClients).where(eq(schema.oauthClients.clientId, clientId));
  return c ?? null;
}
