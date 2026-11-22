import { AUTH_COOKIES } from '@flowforge/shared';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Coarse page gate based on the presence of the non-secret session marker cookie.
 * Real authorization always happens in the API; this only avoids flashing protected UI.
 */
export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has(AUTH_COOKIES.session);
  const { pathname, search } = req.nextUrl;
  const isAuthPage = pathname === '/login' || pathname === '/register';

  if (!hasSession && !isAuthPage) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?returnTo=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  if (hasSession && isAuthPage) {
    const url = req.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except the API proxy, Next internals and static files.
  matcher: ['/((?!api/|_next/|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)'],
};
