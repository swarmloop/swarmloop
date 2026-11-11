import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { apiBaseUrl, publicUrl } from './lib/runtime-config';

const PREFIX = '/swarmloop-api';
const OWN_HOSTS = ['127.0.0.1', 'localhost', '[::1]', 'dashboard'];

/** DNS rebinding guard: only loopback, the public URL host and the compose name may reach the dashboard. */
function hostAllowed(host: string): boolean {
  const value = host.trim().toLowerCase();
  const name = value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : value.split(':')[0];
  return [...OWN_HOSTS, new URL(publicUrl()).hostname.toLowerCase()].includes(name);
}

/** Answers only to its own hosts, and proxies the browser's API calls to the URL the container started with, and only to that host. */
export function middleware(request: NextRequest): NextResponse {
  if (!hostAllowed(request.headers.get('host') ?? request.nextUrl.host)) {
    return new NextResponse(null, { status: 421 });
  }
  const { pathname, search } = request.nextUrl;
  if (!pathname.startsWith(PREFIX)) {
    return NextResponse.next();
  }
  const path = pathname.slice(PREFIX.length);
  // `//host` and `/\host` would make the URL parser switch to another host.
  if (!/^\/(?![/\\])/.test(path) || path.includes('\\')) {
    return new NextResponse(null, { status: 400 });
  }
  return NextResponse.rewrite(new URL(`${path}${search}`, apiBaseUrl()));
}

export const config = { matcher: ['/:path*'] };
