import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CodexAuthStore, REFRESH_AFTER_MS } from './codex-auth';

const NOW = Date.parse('2026-11-10T00:00:00Z');

function seed(lastRefresh: string, refresh = 'rt-1'): string {
  const auth = {
    auth_mode: 'chatgpt',
    tokens: { access_token: 'at-1', refresh_token: refresh, id_token: 'id-1', account_id: 'acc' },
    last_refresh: lastRefresh,
  };
  return Buffer.from(JSON.stringify(auth)).toString('base64');
}

function decode(value: string): { tokens: { access_token: string; refresh_token: string }; last_refresh: string } {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

describe('codex auth store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-auth-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function store(answer: () => Promise<Response>): { store: CodexAuthStore; calls: () => number } {
    let calls = 0;
    const deps = {
      now: () => NOW,
      fetch: (() => {
        calls += 1;
        return answer();
      }) as unknown as typeof fetch,
    };
    return { store: new CodexAuthStore(dir, deps), calls: () => calls };
  }

  const ok = (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2' }), { status: 200 }),
    );

  it('hands out a fresh login without calling the network', async () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    const { store: s, calls } = store(ok);
    expect(decode(await s.current(seed(fresh))).tokens.access_token).toBe('at-1');
    expect(calls()).toBe(0);
  });

  it('refreshes a stale login once for five parallel callers', async () => {
    const stale = new Date(NOW - REFRESH_AFTER_MS - 1000).toISOString();
    const { store: s, calls } = store(ok);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => s.current(seed(stale))));
    expect(calls()).toBe(1);
    for (const result of results) {
      expect(decode(result).tokens.refresh_token).toBe('rt-2');
    }
    const saved = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')) as { last_refresh: string };
    expect(saved.last_refresh).toBe(new Date(NOW).toISOString());
  });

  it('keeps the rotated token across calls while .env stays the same', async () => {
    const stale = new Date(NOW - REFRESH_AFTER_MS - 1000).toISOString();
    const { store: s, calls } = store(ok);
    await s.current(seed(stale));
    expect(decode(await s.current(seed(stale))).tokens.refresh_token).toBe('rt-2');
    expect(calls()).toBe(1);
  });

  it('takes a new login from .env when its value changes', async () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    const { store: s } = store(ok);
    await s.current(seed(fresh, 'rt-1'));
    expect(decode(await s.current(seed(fresh, 'rt-9'))).tokens.refresh_token).toBe('rt-9');
  });

  it('tells the person to log in again when the refresh token is rejected', async () => {
    const stale = new Date(NOW - REFRESH_AFTER_MS - 1000).toISOString();
    const { store: s } = store(() => Promise.resolve(new Response('{}', { status: 401 })));
    await expect(s.current(seed(stale))).rejects.toThrow('Codex login expired');
  });

  it('uses the saved login when the network fails and it is not too old', async () => {
    const stale = new Date(NOW - REFRESH_AFTER_MS - 1000).toISOString();
    const { store: s } = store(() => Promise.reject(new Error('offline')));
    expect(decode(await s.current(seed(stale))).tokens.access_token).toBe('at-1');
  });

  it('rejects a CODEX_AUTH that is not an auth.json', async () => {
    const { store: s } = store(ok);
    await expect(s.current(Buffer.from('nope').toString('base64'))).rejects.toThrow('CODEX_AUTH must be');
  });
});
