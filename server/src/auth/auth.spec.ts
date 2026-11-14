import { execFileSync } from 'child_process';
import { generateKeyPairSync } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConnectionsService } from './connections.service';
import { HostAppsService } from './host-apps.service';
import { CommandService } from '../pipeline/command.service';
import { FAKE_MODEL_KEY } from '../testing/env.spec-helpers';
import { createTestApp, type TestApp } from '../testing/test-app';
import { startFakeHosts, type FakeHost } from './fake-hosts.spec-helpers';
import { startFakeGithub } from './fake-provider.spec-helpers';
import { redirectOf } from './login-problem.spec-helpers';

const TOKEN = 'machine-secret';

describe('login and the auth guard', () => {
  let github: Awaited<ReturnType<typeof startFakeGithub>>;
  let app: TestApp;

  async function start(allow: string): Promise<void> {
    app = await createTestApp({
      env: {
        ...FAKE_MODEL_KEY,
        GITHUB_BASE_URL: github.url,
        GITHUB_OAUTH_CLIENT_ID: 'client',
        GITHUB_OAUTH_CLIENT_SECRET: 'secret',
        SWARMLOOP_ALLOW: allow,
        SWARMLOOP_TOKEN: TOKEN,
      },
    });
  }

  /** Walks login and callback as a browser does and answers the callback response. */
  async function login(user: string, query?: (state: string) => string, cookieState?: string): Promise<Response> {
    const start = await fetch(`${app.url}/auth/github/login`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const bound = cookieState ?? (start.headers.get('set-cookie') ?? '').split(';')[0];
    return fetch(`${app.url}/auth/github/callback?${query?.(state) ?? `code=${user}&state=${state}`}`, {
      redirect: 'manual',
      headers: { cookie: bound.includes('=') ? bound : `swarmloop_state=${bound}` },
    });
  }

  const sessionCookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('swarmloop_session='))
      ?.split(';')[0] ?? '';

  beforeAll(async () => {
    github = await startFakeGithub({ carol: ['Acme'] });
  });
  afterAll(() => github.stop());
  afterEach(() => app.close());

  it('sends the person to GitHub with state and a PKCE S256 challenge, with the callback on the public URL', async () => {
    await start('github:ann');
    const response = await fetch(`${app.url}/auth/github/login`, { redirect: 'manual' });
    const target = new URL(response.headers.get('location') ?? '');
    expect(target.origin + target.pathname).toBe(`${github.url}/login/oauth/authorize`);
    expect(Object.fromEntries(target.searchParams)).toMatchObject({
      client_id: 'client',
      redirect_uri: 'http://127.0.0.1:3921/auth/github/callback',
      scope: 'read:user read:org',
      code_challenge_method: 'S256',
    });
    expect(target.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('lists only the configured providers', async () => {
    await start('github:ann');
    expect(await (await fetch(`${app.url}/auth/providers`)).json()).toEqual({ providers: ['github'] });
    expect((await fetch(`${app.url}/auth/gitlab/login`, { redirect: 'manual' })).status).toBe(404);
  });

  it('logs a listed user in: the session cookie opens the API and /auth/me names the user', async () => {
    await start('github:ann');
    const response = await login('ann');
    expect(response.status).toBe(302);
    const cookie = sessionCookie(response);
    expect(cookie).toMatch(/^swarmloop_session=[0-9a-f]{64}$/);
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly.*SameSite=Lax|SameSite=Lax.*HttpOnly/);
    expect((await fetch(`${app.url}/runs`, { headers: { cookie } })).status).toBe(200);
    expect(await (await fetch(`${app.url}/auth/me`, { headers: { cookie } })).json()).toEqual({
      user: 'ann',
      provider: 'github',
      avatarUrl: 'https://avatars.test/ann.png',
    });
  });

  it('refuses a user outside SWARMLOOP_ALLOW and says which account and why', async () => {
    await start('github:ann');
    const response = await login('mallory');
    expect(redirectOf(response)).toEqual({
      path: '/login',
      query: { error: 'refused', host: 'github', account: 'mallory', reason: 'not listed in SWARMLOOP_ALLOW' },
    });
    expect(sessionCookie(response)).toBe('');
  });

  it('keeps the default of today for a plain OAuth App when the list is empty', async () => {
    await start('');
    // no checkout and no token: the push rule would refuse, the machine rule lets the person in
    expect((await login('ann')).status).toBe(302);
  });

  it('lets in a member of a listed org', async () => {
    await start('github-org:acme');
    expect((await login('carol')).status).toBe(302);
    expect(redirectOf(await login('dave')).query.error).toBe('refused');
  });

  it('refuses a wrong state, a missing state cookie and a replayed login', async () => {
    await start('github:ann');
    expect(redirectOf(await login('ann', () => 'code=ann&state=forged'))).toEqual({
      path: '/login',
      query: { error: 'expired' },
    });
    const start1 = await fetch(`${app.url}/auth/github/login`, { redirect: 'manual' });
    const state = new URL(start1.headers.get('location') ?? '').searchParams.get('state');
    const unbound = await fetch(`${app.url}/auth/github/callback?code=ann&state=${state}`, { redirect: 'manual' });
    expect(redirectOf(unbound).query.error).toBe('expired');
    const cookie = `swarmloop_state=${state}`;
    const first = await fetch(`${app.url}/auth/github/callback?code=ann&state=${state}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(first.status).toBe(302);
    const again = await fetch(`${app.url}/auth/github/callback?code=ann&state=${state}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(redirectOf(again).query.error).toBe('expired');
  });

  it('sends a failing host to the login page as host and keeps every redirect free of codes, states and tokens', async () => {
    await start('github:ann');
    const refused = await login('mallory');
    await app.close();
    app = await createTestApp({
      env: {
        GITHUB_BASE_URL: 'http://127.0.0.1:1',
        GITHUB_OAUTH_CLIENT_ID: 'client',
        GITHUB_OAUTH_CLIENT_SECRET: 'secret',
        SWARMLOOP_ALLOW: 'github:ann',
        SWARMLOOP_TOKEN: TOKEN,
      },
    });
    const failed = await login('ann');
    const { path, query } = redirectOf(failed);
    expect(path).toBe('/login');
    expect(query).toMatchObject({ error: 'host', host: 'github' });
    expect(query.reason).toBeTruthy();
    for (const location of [refused.headers.get('location'), failed.headers.get('location')]) {
      expect(location).not.toMatch(/code=|state=|tok-|token/);
    }
  });

  it('returns to the page the person opened, and to / for anything that is not a same-origin path', async () => {
    await start('github:ann');
    const signInNext = async (next: string): Promise<Response> => {
      const begin = await fetch(`${app.url}/auth/github/login?next=${encodeURIComponent(next)}`, {
        redirect: 'manual',
      });
      const state = new URL(begin.headers.get('location') ?? '').searchParams.get('state') ?? '';
      return fetch(`${app.url}/auth/github/callback?code=ann&state=${state}`, {
        redirect: 'manual',
        headers: { cookie: `swarmloop_state=${state}` },
      });
    };
    expect((await signInNext('/runs/x')).headers.get('location')).toBe('/runs/x');
    for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      expect((await signInNext(next)).headers.get('location')).toBe('/');
    }
    expect((await login('ann')).headers.get('location')).toBe('/');
  });

  it('logs out: the session no longer opens the API', async () => {
    await start('github:ann');
    const cookie = sessionCookie(await login('ann'));
    const out = await fetch(`${app.url}/auth/logout`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(out.status).toBe(201);
    expect(out.headers.get('set-cookie')).toContain('swarmloop_session=;');
    expect((await fetch(`${app.url}/runs`, { headers: { cookie } })).status).toBe(401);
  });

  it('answers 401 on every route but /health and /auth/* without a session or token', async () => {
    await start('github:ann');
    for (const path of ['/runs', '/runs/PROJ-1', '/runs/PROJ-1/history']) {
      expect((await fetch(`${app.url}${path}`)).status).toBe(401);
    }
    const post = await fetch(`${app.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(post.status).toBe(401);
    expect((await fetch(`${app.url}/health`)).status).toBe(200);
  });

  it('takes the machine token as a bearer, and nothing else', async () => {
    await start('github:ann');
    expect((await fetch(`${app.url}/runs`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await fetch(`${app.url}/runs`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${app.url}/runs`, { headers: { cookie: 'swarmloop_session=nope' } })).status).toBe(401);
  });

  it('records who started a run', async () => {
    await start('github:ann');
    const cookie = sessionCookie(await login('ann'));
    const headers = { cookie, 'content-type': 'application/json' };
    const created = await fetch(`${app.url}/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'proj-1', prompt: 'Ship it', projects: ['demo'] }),
    });
    expect(created.status).toBeLessThan(300);
    const flowOf = async () =>
      (await (await fetch(`${app.url}/runs/proj-1`, { headers: { cookie } })).json()) as {
        status: string;
        startedBy?: string;
      };
    expect((await flowOf()).startedBy).toBe('ann');
    await app.app.get(CommandService).idle();
    await app.pipeline.whenIdle('proj-1');
  });
});

describe('without a login provider', () => {
  it('lets every request through, as before', async () => {
    const app = await createTestApp({
      env: { GITHUB_OAUTH_CLIENT_ID: '', GITHUB_OAUTH_CLIENT_SECRET: '', SWARMLOOP_ALLOW: '', SWARMLOOP_TOKEN: TOKEN },
    });
    try {
      // The no-login mode is gone: a browser needs a session even before a login exists, the machine token still opens the API.
      expect((await fetch(`${app.url}/runs`)).status).toBe(401);
      expect((await fetch(`${app.url}/runs`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
      expect(await (await fetch(`${app.url}/auth/providers`)).json()).toEqual({ providers: [] });
    } finally {
      await app.close();
    }
  });
});

describe('login with a connecting app: who may log in when SWARMLOOP_ALLOW is empty', () => {
  let fake: FakeHost;
  let app: TestApp;
  let checkouts: string;

  /** A checkout whose origin is `project` on the fake host. */
  function checkout(name: string, project: string): void {
    const path = join(checkouts, name);
    mkdirSync(path, { recursive: true });
    execFileSync('git', ['init', '-q', path]);
    execFileSync('git', ['-C', path, 'remote', 'add', 'origin', `${fake.url}/${project}.git`]);
  }

  const machine = { authorization: `Bearer ${TOKEN}` };

  async function start(host: 'github' | 'gitlab', allow = ''): Promise<void> {
    fake = await startFakeHosts();
    app = await createTestApp({
      env: {
        // the .env of an earlier app in this file stays in process.env: no OAuth app but the one made here
        GITHUB_OAUTH_CLIENT_ID: '',
        GITHUB_OAUTH_CLIENT_SECRET: '',
        GITLAB_OAUTH_CLIENT_ID: '',
        GITLAB_OAUTH_CLIENT_SECRET: '',
        ...(host === 'github' ? { GITHUB_BASE_URL: fake.url } : { GITLAB_BASE_URL: fake.url }),
        SWARMLOOP_ALLOW: allow,
        SWARMLOOP_TOKEN: TOKEN,
        CHECKOUTS_ROOT: checkouts,
      },
    });
    if (host === 'github') {
      const manifest = await fetch(`${app.url}/auth/github/manifest`, { headers: machine });
      expect(manifest.status).toBe(200);
      const state = new URL(((await manifest.json()) as { action: string }).action).searchParams.get('state') ?? '';
      const created = await fetch(`${app.url}/auth/github/created?code=manifest-code&state=${state}`, {
        redirect: 'manual',
        headers: { ...machine, cookie: `swarmloop_state=${state}` },
      });
      expect(created.status).toBe(302);
    } else {
      const saved = await fetch(`${app.url}/auth/gitlab/application`, {
        method: 'POST',
        headers: { ...machine, 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: 'gl-id', clientSecret: 'gl-secret' }),
      });
      expect(saved.status).toBe(201);
    }
  }

  const signIn = async (host: string, user: string): Promise<Response> => {
    const begin = await fetch(`${app.url}/auth/${host}/login`, { redirect: 'manual' });
    const state = new URL(begin.headers.get('location') ?? '').searchParams.get('state') ?? '';
    return fetch(`${app.url}/auth/${host}/callback?code=${user}&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: `swarmloop_state=${state}` },
    });
  };

  const pushRefusal = (host: string, account: string) => ({
    error: 'refused',
    host,
    account,
    reason: "can't push to any repository this server works on",
  });

  beforeEach(() => {
    checkouts = mkdtempSync(join(tmpdir(), 'swarmloop-auth-checkouts-'));
  });
  afterEach(async () => {
    await app.close();
    await fake.stop();
    rmSync(checkouts, { recursive: true, force: true });
  });

  it('lets in a person who can push, and refuses one with read access only', async () => {
    await start('github');
    checkout('site', 'acme/site');
    fake.pushers.add('ann:acme/site');
    const ok = await signIn('github', 'ann');
    expect(ok.status).toBe(302);
    const cookie =
      ok.headers
        .getSetCookie()
        .find((c) => c.startsWith('swarmloop_session='))
        ?.split(';')[0] ?? '';
    expect(await (await fetch(`${app.url}/auth/me`, { headers: { cookie } })).json()).toMatchObject({
      user: 'ann',
      avatarUrl: 'https://avatars.test/ann.png',
    });
    const refused = await signIn('github', 'bob');
    expect(redirectOf(refused).query).toEqual(pushRefusal('github', 'bob'));
    expect(refused.headers.getSetCookie().some((c) => c.startsWith('swarmloop_session='))).toBe(false);
  });

  it('refuses a person whose token cannot see the repository, and any person when no checkout is on the host', async () => {
    await start('github');
    const away = { 'x-forwarded-host': 'panel.example' };
    const from = async (user: string, headers: Record<string, string>) => {
      const begin = await fetch(`${app.url}/auth/github/login`, { redirect: 'manual' });
      const state = new URL(begin.headers.get('location') ?? '').searchParams.get('state') ?? '';
      return fetch(`${app.url}/auth/github/callback?code=${user}&state=${state}`, {
        redirect: 'manual',
        headers: { ...headers, cookie: `swarmloop_state=${state}` },
      });
    };
    const refused = await from('ann', away);
    expect(redirectOf(refused).query).toEqual(pushRefusal('github', 'ann'));
    expect((await signIn('github', 'ann')).status).toBe(302);
    const second = await signIn('github', 'bob');
    expect(redirectOf(second).query).toEqual(pushRefusal('github', 'bob'));
  });

  it('with a checkout the push rule still decides after the first person', async () => {
    await start('github');
    checkout('site', 'acme/site');
    expect((await signIn('github', 'ann')).status).toBe(302);
    fake.pushers.add('bob:acme/site');
    fake.hidden.add('bob:acme/site');
    expect(redirectOf(await signIn('github', 'bob')).query.error).toBe('refused');
    fake.hidden.clear();
    app.clock.advance(60_000);
    expect((await signIn('github', 'bob')).status).toBe(302);
  });

  it('on GitLab asks for Developer access', async () => {
    await start('gitlab');
    checkout('tool', 'team/dev/tool');
    fake.pushers.add('carol:team/dev/tool');
    expect((await signIn('gitlab', 'carol')).status).toBe(302);
    const refused = await signIn('gitlab', 'dave');
    expect(redirectOf(refused).query).toEqual(pushRefusal('gitlab', 'dave'));
  });

  it('works as today when SWARMLOOP_ALLOW is not empty', async () => {
    await start('github', 'github:bob');
    checkout('site', 'acme/site');
    expect((await signIn('github', 'bob')).status).toBe(302);
    expect(redirectOf(await signIn('github', 'ann')).query.error).toBe('refused');
  });
});

describe('first run: the manifest, the owner, the install step and the install return', () => {
  let fake: FakeHost;
  let app: TestApp;
  let checkouts: string;

  function checkout(name: string, project: string): void {
    const path = join(checkouts, name);
    mkdirSync(path, { recursive: true });
    execFileSync('git', ['init', '-q', path]);
    execFileSync('git', ['-C', path, 'remote', 'add', 'origin', `${fake.url}/${project}.git`]);
  }

  beforeEach(async () => {
    checkouts = mkdtempSync(join(tmpdir(), 'swarmloop-auth-first-run-'));
    fake = await startFakeHosts();
    app = await createTestApp({
      env: {
        GITHUB_OAUTH_CLIENT_ID: '',
        GITHUB_OAUTH_CLIENT_SECRET: '',
        GITHUB_BASE_URL: fake.url,
        SWARMLOOP_ALLOW: '',
        SWARMLOOP_TOKEN: TOKEN,
        CHECKOUTS_ROOT: checkouts,
      },
    });
  });
  afterEach(async () => {
    await app.close();
    await fake.stop();
    rmSync(checkouts, { recursive: true, force: true });
  });

  const manifest = async (owner?: string) => {
    const response = await fetch(`${app.url}/auth/github/manifest${owner === undefined ? '' : `?org=${owner}`}`);
    const form = (await response.json()) as { action: string; manifest: Record<string, unknown> };
    return { ...form, target: new URL(form.action) };
  };

  it('makes the manifest private, and uses the organization page only for an organization', async () => {
    const org = await manifest('acme');
    expect(org.manifest.public).toBe(false);
    expect(org.target.pathname).toBe('/organizations/acme/settings/apps/new');
    expect((await manifest('ann')).target.pathname).toBe('/settings/apps/new');
    expect((await manifest('nobody')).target.pathname).toBe('/settings/apps/new');
    expect((await manifest()).target.pathname).toBe('/settings/apps/new');
  });

  it('names the owner of the checkouts, the most common first, and the others', async () => {
    expect(await (await fetch(`${app.url}/auth/github/owner`)).json()).toEqual({ owner: '', others: [] });
    checkout('a', 'acme/site');
    app.clock.advance(60_000);
    expect(await (await fetch(`${app.url}/auth/github/owner`)).json()).toEqual({ owner: 'acme', others: [] });
    checkout('b', 'zed/one');
    checkout('c', 'zed/two');
    app.clock.advance(60_000);
    expect(await (await fetch(`${app.url}/auth/github/owner`)).json()).toEqual({ owner: 'zed', others: ['acme'] });
  });

  it('makes the app, sends the person to the install step and gives the install link with a state', async () => {
    expect((await fetch(`${app.url}/auth/github/install`)).status).toBe(400);
    const { action } = await manifest();
    const state = new URL(action).searchParams.get('state') ?? '';
    const created = await fetch(`${app.url}/auth/github/created?code=manifest-code&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: `swarmloop_state=${state}` },
    });
    expect(created.status).toBe(302);
    expect(created.headers.get('location')).toBe('/login?install=1');
    const install = await fetch(`${app.url}/auth/github/install`);
    const { url } = (await install.json()) as { url: string };
    const next = new URL(url);
    expect(next.pathname).toBe('/apps/swarmloop-app/installations/new');
    expect(install.headers.getSetCookie().join(';')).toContain(`swarmloop_state=${next.searchParams.get('state')}`);
  });

  it('shows the installed account for an install started on GitHub, and keeps other missing-state callbacks 400', async () => {
    const callback = (query: string) => fetch(`${app.url}/auth/github/callback?${query}`, { redirect: 'manual' });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await app.app.get(HostAppsService).save({
      host: 'github',
      appId: '42',
      slug: 'swarmloop-app',
      clientId: 'Iv.fake',
      clientSecret: 'secret',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      madeBy: 'machine',
    });
    const installed = await callback('installation_id=7&setup_action=install');
    expect(installed.status).toBe(302);
    expect(installed.headers.get('location')).toBe('/login?installed=acme');
    const call = fake.seen.find((seen) => seen.path === '/api/v3/app/installations/7');
    expect(call?.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect((await callback('installation_id=8&setup_action=install')).headers.get('location')).toBe(
      '/login?installed=',
    );
    expect(redirectOf(await callback('setup_action=install')).query.error).toBe('expired');
    expect(redirectOf(await callback('installation_id=7&setup_action=update')).query.error).toBe('expired');
    expect(redirectOf(await callback('installation_id=7&setup_action=install&code=x')).query.error).toBe('expired');
  });

  it('closes the owner route once an app exists, and the install route to others and after a login', async () => {
    const { action } = await manifest();
    const state = new URL(action).searchParams.get('state') ?? '';
    await fetch(`${app.url}/auth/github/created?code=manifest-code&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: `swarmloop_state=${state}` },
    });
    expect((await fetch(`${app.url}/auth/github/owner`)).status).toBe(403);
    const away = { 'x-forwarded-host': 'panel.example' };
    expect((await fetch(`${app.url}/auth/github/install`, { headers: away })).status).toBe(403);
    expect((await fetch(`${app.url}/auth/github/install`)).status).toBe(200);
    await app.app.get(ConnectionsService).connect('github', 'ann', { accessToken: 'ghu_ann_1', refreshToken: '' });
    expect((await fetch(`${app.url}/auth/github/install`)).status).toBe(403);
  });
});
