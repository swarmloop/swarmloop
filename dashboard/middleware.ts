import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { apiBaseUrl } from './lib/runtime-config';

const PREFIX = '/swarmloop-api';

/** Proxies the browser's API calls to the URL the container started with, and only to that host. */
export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const path = pathname.slice(PREFIX.length);
  // `//host` and `/\host` would make the URL parser switch to another host.
  if (!/^\/(?![/\\])/.test(path) || path.includes('\\')) {
    return new NextResponse(null, { status: 400 });
  }
  return NextResponse.rewrite(new URL(`${path}${search}`, apiBaseUrl()));
}

export const config = { matcher: ['/swarmloop-api/:path*'] };
