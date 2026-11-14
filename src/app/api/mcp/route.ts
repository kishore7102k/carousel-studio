import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { verifyApiKey } from '@/lib/auth';
import { registerStudio } from '@/lib/mcp/server';
import { issuer, RESOURCE_METADATA_PATH } from '@/lib/oauth/core';

export const maxDuration = 300;

const handler = createMcpHandler(registerStudio, {
  serverInfo: { name: 'carousel-studio', version: '0.1.0' },
});

const authed = withMcpAuth(handler, async (_req, token) => {
  const agent = await verifyApiKey(token);
  return agent ? { token: token!, clientId: agent.name, scopes: agent.scopes, extra: { keyId: agent.id } } : undefined;
}, {
  required: true,
  // 401s carry WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource/api/mcp"
  resourceMetadataPath: RESOURCE_METADATA_PATH,
  resourceUrl: issuer(),
});

export { authed as GET, authed as POST, authed as DELETE };
