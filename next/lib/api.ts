function apiUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (typeof window === 'undefined') {
    const base = process.env.SWARMLOOP_API_URL ?? 'http://127.0.0.1:3920';
    return `${base}${suffix}`;
  }
  return `/swarmloop-api${suffix}`;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    cache: 'no-store',
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  return response.json() as Promise<T>;
}

export async function runLog(runKey: string, name: string): Promise<string | null> {
  const response = await fetch(`/run-logs/${runKey}-${name}-output.txt`, { cache: 'no-store' });
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
