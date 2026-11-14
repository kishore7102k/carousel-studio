// Discovery documents (RFC 9728 protected resource, RFC 8414 authorization server). Not a route:
// the route.ts files next to this one serve these. Every URL comes from issuer()/mcpResource(),
// never from the request, so a spoofed Host header cannot change what clients are told.
import { generateProtectedResourceMetadata, metadataCorsOptionsRequestHandler } from 'mcp-handler';
import { CORS_HEADERS, SCOPES, corsPreflight, issuer, mcpResource } from '@/lib/oauth/core';

const CACHE = 'public, max-age=3600';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': CACHE, ...CORS_HEADERS },
  });

export function protectedResourceMetadata() {
  return generateProtectedResourceMetadata({
    authServerUrls: [issuer()],
    resourceUrl: mcpResource(),
    additionalMetadata: { scopes_supported: [...SCOPES], bearer_methods_supported: ['header'] },
  });
}

export function authorizationServerMetadata() {
  const base = issuer();
  const authMethods = ['none', 'client_secret_post', 'client_secret_basic'];
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: authMethods,
    revocation_endpoint_auth_methods_supported: authMethods,
    scopes_supported: [...SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** GET + OPTIONS for /.well-known/oauth-protected-resource[/api/mcp]. */
export const protectedResourceRoute = {
  GET: () => json(protectedResourceMetadata()),
  OPTIONS: metadataCorsOptionsRequestHandler(),
};

/** GET + OPTIONS for /.well-known/oauth-authorization-server and /.well-known/openid-configuration. */
export const authorizationServerRoute = {
  GET: () => json(authorizationServerMetadata()),
  OPTIONS: () => corsPreflight(),
};
