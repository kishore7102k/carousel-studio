// Dynamic Client Registration (RFC 7591). Public (no session), CORS, rate-limited per IP.
import { clientIp, corsPreflight, oauthError, oauthJson } from '@/lib/oauth/core';
import { cleanupUnusedClients, registerClient, registrationsSince, validateRegistration } from '@/lib/oauth/clients';

const MAX_BODY = 16 * 1024;
const HOURLY_LIMIT = 20;

export async function POST(req: Request) {
  const text = await req.text();
  if (text.length > MAX_BODY) return oauthError('invalid_client_metadata', 'Request body too large');
  let body: unknown;
  try { body = JSON.parse(text); } catch { return oauthError('invalid_client_metadata', 'Body must be a JSON object'); }

  const v = validateRegistration(body);
  if (!v.ok) return oauthError(v.error, v.description);

  const ip = clientIp(req);
  if ((await registrationsSince(ip, new Date(Date.now() - 60 * 60 * 1000))) >= HOURLY_LIMIT)
    return oauthError('too_many_requests', `At most ${HOURLY_LIMIT} registrations per hour`, 429, { 'Retry-After': '3600' });

  await cleanupUnusedClients();
  const { clientId, clientSecret, issuedAt } = await registerClient(v.metadata, ip);
  const m = v.metadata;
  return oauthJson(
    {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
      client_name: m.clientName,
      redirect_uris: m.redirectUris,
      grant_types: m.grantTypes,
      response_types: m.responseTypes,
      token_endpoint_auth_method: m.tokenAuthMethod,
      ...(m.scope ? { scope: m.scope } : {}),
      ...(m.logoUri ? { logo_uri: m.logoUri } : {}),
      ...(m.clientUri ? { client_uri: m.clientUri } : {}),
    },
    201,
  );
}

export const OPTIONS = () => corsPreflight();
