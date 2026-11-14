// Authorization codes, access/refresh tokens, rotation and revocation. Phase 2 items 6-8.
import type { Scope } from './core';

export type AccessGrant = { clientId: string; clientName: string; scopes: Scope[] };

/**
 * Verifies a `sat_` access token for the MCP endpoint: known hash, kind access, not revoked, not expired,
 * audience = mcpResource(). Returns the grant or null. Phase 2 item 8 implements it.
 */
export async function verifyAccessToken(token: string): Promise<AccessGrant | null> {
  void token;
  return null;
}
