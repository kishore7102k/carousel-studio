import { corsPreflight } from '@/lib/oauth/core';
import { tokenEndpoint } from '@/lib/oauth/tokens';

// POST /oauth/token: authorization_code (PKCE S256) and refresh_token grants. Logic in src/lib/oauth/tokens.ts.
export const POST = (req: Request) => tokenEndpoint(req);
export const OPTIONS = () => corsPreflight();
