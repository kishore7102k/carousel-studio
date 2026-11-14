import { authorizationServerRoute } from '@/app/.well-known/metadata';

// RFC 8414 authorization server metadata (same document at both well-known paths).
export const GET = authorizationServerRoute.GET;
export const OPTIONS = authorizationServerRoute.OPTIONS;
