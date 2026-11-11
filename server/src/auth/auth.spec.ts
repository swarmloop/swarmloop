import { CommandService } from '../pipeline/command.service';
import { createTestApp, type TestApp } from '../testing/test-app';
import { startFakeGithub } from './fake-provider.spec-helpers';

const TOKEN = 'machine-secret';

describe('login and the auth guard', () => {
  let github: Awaited<ReturnType<typeof startFakeGithub>>;
  let app: TestApp;

  async function start(allow: string): Promise<void> {
    app = await createTestApp({
      env: {
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
    });
  });

  it('refuses a user outside SWARMLOOP_ALLOW and says which account and why', async () => {
    await start('github:ann');
    const response = await login('mallory');
    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toBe(
      'github:mallory may not log in: not listed in SWARMLOOP_ALLOW',
    );
    expect(sessionCookie(response)).toBe('');
  });

  it('lets in a member of a listed org', async () => {
    await start('github-org:acme');
    expect((await login('carol')).status).toBe(302);
    expect((await login('dave')).status).toBe(403);
  });

  it('refuses a wrong state, a missing state cookie and a replayed login', async () => {
    await start('github:ann');
    expect((await login('ann', () => 'code=ann&state=forged')).status).toBe(400);
    const start1 = await fetch(`${app.url}/auth/github/login`, { redirect: 'manual' });
    const state = new URL(start1.headers.get('location') ?? '').searchParams.get('state');
    expect((await fetch(`${app.url}/auth/github/callback?code=ann&state=${state}`)).status).toBe(400);
    const cookie = `swarmloop_state=${state}`;
    const first = await fetch(`${app.url}/auth/github/callback?code=ann&state=${state}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(first.status).toBe(302);
    const again = await fetch(`${app.url}/auth/github/callback?code=ann&state=${state}`, { headers: { cookie } });
    expect(again.status).toBe(400);
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
      env: { GITHUB_OAUTH_CLIENT_ID: '', GITHUB_OAUTH_CLIENT_SECRET: '', SWARMLOOP_ALLOW: '' },
    });
    try {
      expect((await fetch(`${app.url}/runs`)).status).toBe(200);
      expect(await (await fetch(`${app.url}/auth/providers`)).json()).toEqual({ providers: [] });
    } finally {
      await app.close();
    }
  });
});
