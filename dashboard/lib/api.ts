import { apiBaseUrl } from './runtime-config';

function apiUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (typeof window === 'undefined') {
    return `${apiBaseUrl()}${suffix}`;
  }
  return `/swarmloop-api${suffix}`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A 401 means the session is gone: the browser goes to the login page, unless it is there already. */
function signedOut(response: Response): void {
  if (response.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.assign('/login');
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
    throw new ApiError(response.status, await errorMessage(response));
  }
  return response.json() as Promise<T>;
}

/** `tail` is the last lines; `from` is a 1-based first line; both give up to `tail` lines from `from`. */
export interface LogPaging {
  tail?: number;
  from?: number;
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
  const query = params.toString() ? `?${params}` : '';
  const path = `/runs/${encodeURIComponent(runKey)}/steps/${encodeURIComponent(name)}/log${query}`;
  const response = await fetch(apiUrl(path), { cache: 'no-store', credentials: 'include' });
  signedOut(response);
  if (!response.ok) {
    return null;
  }
  return response.text();
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    if (Array.isArray(body.message)) {
      return body.message.join(', ');
    }
    if (body.message) {
      return body.message;
    }
  } catch {
    return `HTTP ${response.status}`;
  }
  return `HTTP ${response.status}`;
}
