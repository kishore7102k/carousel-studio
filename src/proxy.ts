import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, validSession } from '@/lib/auth';

// The UI is password-gated. /api/mcp has its own bearer auth. Public OAuth endpoints (discovery, token,
// register, revoke) and the dev-only CIMD test document bypass the gate via the matcher below;
// /oauth/authorize stays gated because the password login IS the authorization step.
export async function proxy(req: NextRequest) {
  if (await validSession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const url = new URL('/login', req.url);
  // Keep the query string: /oauth/authorize?client_id=…&state=… must survive the login round trip.
  url.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    '/((?!login|api/mcp|api/dev/cimd-test$|\\.well-known/|oauth/(?:token|register|revoke)$|_next/static|_next/image|favicon.ico).*)',
  ],
};
