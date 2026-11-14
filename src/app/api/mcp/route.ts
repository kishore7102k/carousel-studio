import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { verifyApiKey } from '@/lib/auth';
import { registerStudio } from '@/lib/mcp/server';
import { issuer, RESOURCE_METADATA_PATH } from '@/lib/oauth/core';
import { verifyAccessToken } from '@/lib/oauth/tokens';

export const maxDuration = 300;

const handler = createMcpHandler(registerStudio, {
  serverInfo: { name: 'carousel-studio', version: '0.1.0' },
});

// Bearer verifier: ks_ API keys (header-configured agents) or sat_ OAuth access tokens (web connectors).
// clientId is the activity actor: the key name, or the OAuth client's name (e.g. ChatGPT, Claude).
const authed = withMcpAuth(handler, async (_req, token) => {
  if (!token) return undefined;
  if (token.startsWith('ks_')) {
    const agent = await verifyApiKey(token);
    return agent ? { token, clientId: agent.name, scopes: agent.scopes, extra: { keyId: agent.id } } : undefined;
  }
  if (token.startsWith('sat_')) {
    const grant = await verifyAccessToken(token);
    return grant
      ? { token, clientId: grant.clientName, scopes: grant.scopes, expiresAt: grant.expiresAt, extra: { oauthClientId: grant.clientId } }
      : undefined;
  }
  return undefined;
}, {
  required: true,
  // 401s carry WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource/api/mcp"
  resourceMetadataPath: RESOURCE_METADATA_PATH,
  resourceUrl: issuer(),
});

export { authed as GET, authed as POST, authed as DELETE };
