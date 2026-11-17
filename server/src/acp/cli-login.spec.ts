import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { AuthDeps } from './cli-login';
import { runAuthCommand } from './cli-login';
import { NOT_SIGNED_IN, configPath, tokenSource } from './cli-token';
import { HttpServerApi } from './server-api';
import { runShell } from './shell';

interface Call {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

function setup(polls: unknown[], env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sloop-login-'));
  const calls: Call[] = [];
  const lines: string[] = [];
  const waits: number[] = [];
  const queue = [...polls];
  const fakeFetch = ((url: string, init: RequestInit) => {
    const path = url.replace('http://nest', '');
    const headers = init.headers as Record<string, string>;
    calls.push({
      method: init.method ?? 'GET',
      path,
      authorization: headers.authorization,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    let payload: unknown = {};
    if (path === '/auth/cli/logins') {
      payload = { id: 'id1', code: 'ABCD-1234', url: 'http://dash/cli-login?code=ABCD-1234', expiresAt: 'later' };
    } else if (path === '/auth/cli/logins/id1') {
      payload = queue.shift();
    } else if (path === '/tokens/current' && init.method === 'GET') {
      payload = { id: 1, login: 'ada', name: 'cli' };
    }
    const status = init.method === 'DELETE' ? 204 : 200;
    return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(payload), { status }));
  }) as typeof fetch;
  const deps: AuthDeps = {
    apiFor: (token) => new HttpServerApi('http://nest', token, fakeFetch),
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    print: (line) => lines.push(line),
    machine: 'laptop',
    env: { XDG_CONFIG_HOME: home, ...env },
  };
  return { deps, calls, lines, waits, file: configPath(deps.env) };
}

describe('sloop login and logout', () => {
  it('shows the code, waits for approval and stores the token as 0600', async () => {
    const { deps, calls, lines, waits, file } = setup([{ status: 'waiting' }, { status: 'approved', token: 'tok-1' }]);
    expect(await runAuthCommand(['login'], deps)).toBe(true);
    expect(lines).toEqual(['Open http://dash/cli-login?code=ABCD-1234 and approve code ABCD-1234', 'Signed in as ada']);
    expect(waits).toEqual([2000]);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/auth/cli/logins', body: { machine: 'laptop' } });
    expect(calls[0]?.authorization).toBeUndefined();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ token: 'tok-1' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('says when SWARMLOOP_TOKEN is set and used instead', async () => {
    const { deps, lines } = setup([{ status: 'approved', token: 'tok-1' }], { SWARMLOOP_TOKEN: 'env-tok' });
    await runAuthCommand(['login'], deps);
    expect(lines).toContain('SWARMLOOP_TOKEN is set and is used instead of this login');
  });

  it('stores nothing when the login expired', async () => {
    const { deps, file } = setup([{ status: 'expired' }]);
    await expect(runAuthCommand(['login'], deps)).rejects.toThrow('expired');
    expect(existsSync(file)).toBe(false);
  });

  it('checks a pasted token with GET /tokens/current and stores it', async () => {
    const { deps, calls, lines, file } = setup([]);
    await runAuthCommand(['login', '--token', 'pasted'], deps);
    expect(calls).toEqual([
      { method: 'GET', path: '/tokens/current', authorization: 'Bearer pasted', body: undefined },
    ]);
    expect(lines).toEqual(['Signed in as ada']);
    expect(readFileSync(file, 'utf8')).toContain('pasted');
  });

  it('revokes the file token and deletes the file, and leaves the env token alone', async () => {
    const { deps, calls, file } = setup([], { SWARMLOOP_TOKEN: 'env-tok' });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ token: 'file-tok' }));
    await runAuthCommand(['logout'], deps);
    expect(calls).toEqual([
      { method: 'DELETE', path: '/tokens/current', authorization: 'Bearer file-tok', body: undefined },
    ]);
    expect(existsSync(file)).toBe(false);
    expect(deps.env.SWARMLOOP_TOKEN).toBe('env-tok');
  });

  it('says not signed in without a file', async () => {
    const { deps, calls, lines } = setup([]);
    await runAuthCommand(['logout'], deps);
    expect(lines).toEqual(['not signed in']);
    expect(calls).toEqual([]);
  });

  it('leaves other commands to the shell', async () => {
    expect(await runAuthCommand(['PROJ-1'], setup([]).deps)).toBe(false);
  });
});

describe('tokenSource', () => {
  it('prefers SWARMLOOP_TOKEN over the file, and is null with neither', () => {
    const { deps, file } = setup([]);
    expect(tokenSource(deps.env)).toBeNull();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ token: 'file-tok' }));
    expect(tokenSource(deps.env)).toBe('file-tok');
    expect(tokenSource({ ...deps.env, SWARMLOOP_TOKEN: 'env-tok' })).toBe('env-tok');
  });
});

describe('a command with no token', () => {
  const saved = { token: process.env.SWARMLOOP_TOKEN, config: process.env.XDG_CONFIG_HOME };

  afterEach(() => {
    process.exitCode = undefined;
    for (const [name, value] of [
      ['SWARMLOOP_TOKEN', saved.token],
      ['XDG_CONFIG_HOME', saved.config],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('exits 1 with the contract text', async () => {
    delete process.env.SWARMLOOP_TOKEN;
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'sloop-none-'));
    const written: string[] = [];
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await runShell(['review']);
    } finally {
      spy.mockRestore();
    }
    expect(written.join('')).toBe(`${NOT_SIGNED_IN}\n`);
    expect(process.exitCode).toBe(1);
  });
});
