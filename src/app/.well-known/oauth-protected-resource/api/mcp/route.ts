import { protectedResourceRoute } from '@/app/.well-known/metadata';

// RFC 9728 protected resource metadata for /api/mcp.
export const GET = protectedResourceRoute.GET;
export const OPTIONS = protectedResourceRoute.OPTIONS;
