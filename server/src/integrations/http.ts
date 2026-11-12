import type { Clock } from '../core/clock';
import { recordStepEvent } from '../core/step-event-scope';
import { HostUnavailable, type HttpCallDraft } from '../core/swarmloop-error';

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
const HOST_TRIES = 5;
const BACKOFF_BASE_MS = 8_000;
const BACKOFF_CAP_MS = 40_000;
const RETRY_AFTER_CAP_MS = 60_000;
/** How long a host that kept failing is left alone before the next automatic try. */
export const HOST_RETRY_MS = 5 * 60_000;
const MAX_BYTES = 20 * 1024 * 1024;

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
  }
}

function safeUrl(raw: string): string {
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
  return (
    type.startsWith('text/') ||
    type.includes('json') ||
    type.includes('xml') ||
    type.includes('yaml') ||
    type.includes('html')
  );
}

function providerFor(url: string): HttpCallDraft['provider'] {
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
  sleep: (attempt: number, error: unknown) => Promise<void> = async (attempt) =>
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
      await sleep(attempt + 1, error);
    }
  }
  throw last;
}

export interface HostRetryTiming {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** The shared policy of every host call: 5 tries, exponential backoff with full jitter, `Retry-After` first. */
export async function withHostRetries<T>(
  run: () => Promise<T>,
  isTransient: (error: unknown) => boolean,
  timing: HostRetryTiming = {},
): Promise<T> {
  const sleep = timing.sleep ?? (async (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = timing.random ?? Math.random;
  return withRetries(run, isTransient, HOST_TRIES - 1, async (attempt, error) => {
    const advised = error instanceof HttpStatusError ? error.retryAfterMs : null;
    const backoff = random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    await sleep(advised ?? backoff);
  });
}

/** `Retry-After` as seconds or an HTTP date, in ms from `now`; null when absent or unreadable. */
function retryAfterMs(value: string | null, now: number): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), RETRY_AFTER_CAP_MS) : null;
}

function isTimeout(error: unknown): boolean {
  const { name, code } = error as { name?: string; code?: string };
  return (
    name === 'TimeoutError' || name === 'AbortError' || (typeof code === 'string' && /^UND_ERR_.*TIMEOUT$/.test(code))
  );
}

/** A status, a network error (`fetch` throws a `TypeError`) or a timeout that a later try may fix. */
function isTransient(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return TRANSIENT.has(error.status);
  }
  return error instanceof TypeError || isTimeout(error);
}

export async function request(
  clock: Clock,
  url: string,
  headers: Record<string, string>,
  calls: HttpCallDraft[],
  init: { method?: string; body?: string } = {},
  timing: HostRetryTiming = {},
): Promise<{
  status: number;
  url: string;
  contentType: string | null;
  body: Buffer;
  headers: { get(name: string): string | null };
}> {
  const started = clock.now();
  const method = init.method ?? 'GET';
  const safe = safeUrl(url);
  try {
    const response = await withHostRetries(
      async () => {
        const result = await fetch(url, { method, headers, body: init.body, redirect: 'follow' });
        if (TRANSIENT.has(result.status)) {
          throw new HttpStatusError(result.status, safe, retryAfterMs(result.headers.get('retry-after'), clock.now()));
        }
        return result;
      },
      isTransient,
      timing,
    );
    const body = Buffer.from(await response.arrayBuffer());
    calls.push({
      provider: providerFor(response.url || url),
      method,
      url: safeUrl(response.url || url),
      statusCode: response.status,
      durationMs: clock.now() - started,
      error: response.ok ? null : `HTTP ${response.status}`,
    });
    recordStepEvent({
      kind: 'http.call',
      method,
      url: safeUrl(response.url || url),
      statusCode: response.status,
      durationMs: clock.now() - started,
    });
    return {
      status: response.status,
      url: response.url || url,
      contentType: response.headers.get('content-type'),
      body,
      headers: response.headers,
    };
  } catch (error) {
    const status = error instanceof HttpStatusError ? error.status : null;
    const message = error instanceof Error ? error.message : 'request failed';
    calls.push({
      provider: providerFor(url),
      method,
      url: safe,
      statusCode: status,
      durationMs: clock.now() - started,
      error: message,
    });
    recordStepEvent({ kind: 'http.call', method, url: safe, statusCode: status, durationMs: clock.now() - started });
    if (isTransient(error)) {
      const detail = status === null ? message : `HTTP ${status}`;
      throw new HostUnavailable(
        new URL(url).hostname,
        detail,
        new Date(clock.now() + HOST_RETRY_MS).toISOString(),
        calls,
      );
    }
    throw error;
  }
}
