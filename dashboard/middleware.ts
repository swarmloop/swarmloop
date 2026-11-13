import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { apiBaseUrl, publicUrl } from './lib/runtime-config';

const PREFIX = '/swarmloop-api';
/** The OAuth callback is `SWARMLOOP_PUBLIC_URL/auth/<provider>/callback`, the dashboard origin, so the API serves it here. */
const AUTH_PREFIX = '/auth/';
/** Plain segments only: no empty one (`/auth//evil`) and no backslash. */
const AUTH_PATH = /^\/auth(\/[^/\\]+)+$/;
/** How long the API may take to start answering before the dashboard says the server is busy. */
const PROXY_WAIT_MS = 10_000;
const OWN_HOSTS = ['127.0.0.1', 'localhost', '[::1]', 'dashboard'];

/** DNS rebinding guard: only loopback, the public URL host and the compose name may reach the dashboard. */
function hostAllowed(host: string): boolean {
  const value = host.trim().toLowerCase();
  const name = value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : value.split(':')[0];
  return [...OWN_HOSTS, new URL(publicUrl()).hostname.toLowerCase()].includes(name);
}

/** `//host` and `/\host` would make the URL parser switch to another host. */
function pathRefused(path: string): boolean {
  return !/^\/(?![/\\])/.test(path) || path.includes('\\');
}

/** The API call goes on with its method, headers and body. A wait for headers longer than `PROXY_WAIT_MS`, or a refused connection, means the server is busy. */
async function forward(request: NextRequest, path: string, search: string): Promise<NextResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_WAIT_MS);
  try {
    const headers = new Headers(request.headers);
    headers.delete('host');
    const upstream = await fetch(new URL(`${path}${search}`, apiBaseUrl()), {
      method: request.method,
      headers,
      body: request.body,
      duplex: 'half',
      redirect: 'manual',
      signal: controller.signal,
    } as RequestInit);
    // `fetch` already decoded the body, so its encoding and length no longer describe it.
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return NextResponse.json({ message: 'the server is busy' }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}

/** Answers only to its own hosts, and proxies the browser's API calls to the URL the container started with, and only to that host. */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  if (!hostAllowed(request.headers.get('host') ?? request.nextUrl.host)) {
    return new NextResponse(null, { status: 421 });
  }
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith(AUTH_PREFIX)) {
    if (!AUTH_PATH.test(pathname) || pathRefused(pathname)) {
      return new NextResponse(null, { status: 400 });
    }
    return NextResponse.rewrite(new URL(`${pathname}${search}`, apiBaseUrl()));
  }
  if (!pathname.startsWith(PREFIX)) {
    return NextResponse.next();
  }
  const path = pathname.slice(PREFIX.length);
  return pathRefused(path) ? new NextResponse(null, { status: 400 }) : forward(request, path, search);
}

export const config = { matcher: ['/:path*'] };
