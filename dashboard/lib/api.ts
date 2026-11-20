import { apiBaseUrl } from './runtime-config';

function apiUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (typeof window === 'undefined') {
    return `${apiBaseUrl()}${suffix}`;
  }
  return `/swarmloop-api${suffix}`;
}

/** What the dashboard's proxy answers with 503 when the API does not answer in time. */
const PROXY_BUSY_MESSAGE = 'the server is busy';
/** What the dashboard's proxy answers with 503 when the connection to the API fails. */
const PROXY_UNREACHABLE_MESSAGE = 'the server is unreachable';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The dashboard's proxy got no answer from the API (too slow, or unreachable): worth retrying. */
    readonly busy = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A 401 means the session is gone: the browser goes to the login page with the page it left as `next`, unless it is there already. */
function signedOut(response: Response): void {
  if (response.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    cache: 'no-store',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(init?.method && init.method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Swarmloop': '1' } : {}),
      ...init?.headers,
    },
  });
  signedOut(response);
  if (!response.ok) {
    const { message, code } = await errorBody(response);
    if (response.status === 503 && message === PROXY_BUSY_MESSAGE) {
      throw new ApiError(503, 'The server is busy, retrying', true);
    }
    if (response.status === 503 && message === PROXY_UNREACHABLE_MESSAGE) {
      throw new ApiError(
        503,
        `The dashboard cannot reach the server (${code ?? 'unknown'}), retrying. If it lasts, run docker compose up -d --force-recreate server dashboard in the swarmloop folder.`,
        true,
      );
    }
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

/** `tail` is the last lines; `from` is a 1-based first line; both give up to `tail` lines from `from`. */
export interface LogPaging {
  tail?: number;
  from?: number;
  /** The index of a check command: the log is that command's output, not the step's. */
  command?: number;
}

export async function runLog(
  runKey: string,
  name: string,
  attempt?: string,
  paging: LogPaging = {},
): Promise<string | null> {
  const params = new URLSearchParams();
  if (attempt) {
    params.set('attempt', attempt);
  }
  if (paging.tail !== undefined) {
    params.set('tail', String(paging.tail));
  }
  if (paging.from !== undefined) {
    params.set('from', String(paging.from));
  }
  if (paging.command !== undefined) {
    params.set('command', String(paging.command));
  }
  const query = params.toString() ? `?${params}` : '';
  const path = `/runs/${encodeURIComponent(runKey)}/steps/${encodeURIComponent(name)}/log${query}`;
  const response = await fetch(apiUrl(path), { cache: 'no-store', credentials: 'include' });
  signedOut(response);
  if (!response.ok) {
    return null;
  }
  return response.text();
}

async function errorBody(response: Response): Promise<{ message: string; code?: string }> {
  const fallback = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { message?: string | string[]; code?: unknown };
    const code = typeof body.code === 'string' ? body.code : undefined;
    if (Array.isArray(body.message)) {
      return { message: body.message.join(', '), code };
    }
    return { message: body.message || fallback, code };
  } catch {
    return { message: fallback };
  }
}
