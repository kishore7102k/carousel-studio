import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, validSession } from '@/lib/auth';

// The UI is password-gated. /api/mcp has its own bearer-key auth.
export async function proxy(req: NextRequest) {
  if (await validSession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const url = new URL('/login', req.url);
  url.searchParams.set('next', req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!login|api/mcp|_next/static|_next/image|favicon.ico).*)'],
};
