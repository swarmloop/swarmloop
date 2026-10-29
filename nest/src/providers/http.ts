import { HttpCallDraft } from '../swarmloop-error';

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_BYTES = 20 * 1024 * 1024;

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
  }
}

export function safeUrl(raw: string): string {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  for (const key of ['token', 'private_token', 'access_token', 'api_token', 'key']) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

export function isReadable(contentType: string | null, body: Buffer): boolean {
  if (body.length === 0 || body.length > MAX_BYTES || body.includes(0)) {
    return false;
  }
  const type = (contentType ?? '').toLowerCase();
  return type.startsWith('text/') || type.includes('json') || type.includes('xml') || type.includes('yaml') || type.includes('html');
}

export function providerFor(url: string): HttpCallDraft['provider'] {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const host = parsed.hostname.toLowerCase();
  if (path.includes('/wiki/')) {
    return 'confluence';
  }
  if (path.startsWith('/rest/api/')) {
    return 'jira';
  }
  if (path.startsWith('/api/v4/')) {
    return 'gitlab';
  }
  if (host === 'api.github.com' || path.startsWith('/api/v3/')) {
    return 'github';
  }
  return 'other';
}

export async function withRetries<T>(
  run: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  retries = 2,
  sleep: (attempt: number) => Promise<void> = async (attempt) =>
    new Promise((resolve) => setTimeout(resolve, 200 * attempt)),
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (attempt === retries || !shouldRetry(error)) {
        break;
      }
      await sleep(attempt + 1);
    }
  }
  throw last;
}

export function retryable(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return RETRYABLE.has(error.status);
  }
  return true;
}

export async function request(
  url: string,
  headers: Record<string, string>,
  calls: HttpCallDraft[],
  init: { method?: string; body?: string } = {},
): Promise<{ status: number; contentType: string | null; body: Buffer; headers: { get(name: string): string | null } }> {
  const started = Date.now();
  const method = init.method ?? 'GET';
  const safe = safeUrl(url);
  try {
    const response = await withRetries(async () => {
      const result = await fetch(url, { method, headers, body: init.body, redirect: 'follow' });
      if (RETRYABLE.has(result.status)) {
        throw new HttpStatusError(result.status, safe);
      }
      return result;
    }, retryable);
    const body = Buffer.from(await response.arrayBuffer());
    calls.push({
      provider: providerFor(response.url || url),
      method,
      url: safeUrl(response.url || url),
      statusCode: response.status,
      durationMs: Date.now() - started,
      error: response.ok ? null : `HTTP ${response.status}`,
    });
    return { status: response.status, contentType: response.headers.get('content-type'), body, headers: response.headers };
  } catch (error) {
    const status = error instanceof HttpStatusError ? error.status : null;
    calls.push({
      provider: providerFor(url),
      method,
      url: safe,
      statusCode: status,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'request failed',
    });
    throw error;
  }
}
