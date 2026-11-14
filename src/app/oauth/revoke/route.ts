import { corsPreflight } from '@/lib/oauth/core';
import { revokeEndpoint } from '@/lib/oauth/tokens';

// POST /oauth/revoke (RFC 7009). Logic in src/lib/oauth/tokens.ts.
export const POST = (req: Request) => revokeEndpoint(req);
export const OPTIONS = () => corsPreflight();
