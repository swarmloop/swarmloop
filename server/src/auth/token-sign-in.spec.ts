import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FAKE_MODEL_KEY } from '../testing/env.spec-helpers';
import { createTestApp, type TestApp } from '../testing/test-app';
import { ConnectionsService } from './connections.service';
import { startFakeHosts, type FakeHost } from './fake-hosts.spec-helpers';

describe('signing in with a personal access token', () => {
  let fake: FakeHost;
  let app: TestApp;
  let checkouts: string;

  async function start(allow = '', seedAdmin = true): Promise<void> {
    checkouts = mkdtempSync(join(tmpdir(), 'swarmloop-token-'));
    fake = await startFakeHosts();
    app = await createTestApp({
      seedAdmin,
      env: {
        ...FAKE_MODEL_KEY,
        GITHUB_OAUTH_CLIENT_ID: '',
        GITHUB_OAUTH_CLIENT_SECRET: '',
        GITLAB_OAUTH_CLIENT_ID: '',
        GITLAB_OAUTH_CLIENT_SECRET: '',
        GITLAB_BASE_URL: fake.url,
        SWARMLOOP_ALLOW: allow,
        SWARMLOOP_TOKEN: '',
        CHECKOUTS_ROOT: checkouts,
      },
    });
  }

  const post = (provider: string, body: unknown): Promise<Response> =>
    fetch(`${app.url}/auth/${provider}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-swarmloop': '1' },
      body: JSON.stringify(body),
    });

  const connections = () => app.app.get(ConnectionsService);

  afterEach(async () => {
    await app.close();
    await fake.stop();
    rmSync(checkouts, { recursive: true, force: true });
  });

  it('lists the host that takes a token, with its base and where the token is made, without an application', async () => {
    await start();
    const view = (await (await fetch(`${app.url}/auth/providers`)).json()) as {
      providers: string[];
      tokens: { provider: string; base: string; tokenPage: string }[];
    };
    expect(view.providers).toEqual([]);
    expect(view.tokens).toHaveLength(1);
    expect(view.tokens[0]).toMatchObject({ provider: 'gitlab', base: fake.url });
    expect(view.tokens[0].tokenPage).toMatch(
      /\/-\/user_settings\/personal_access_tokens\?name=swarmloop&scopes=read_user,api,write_repository$/,
    );
  });

  it('signs the first person in as admin, as the OAuth login does, and keeps the token as it is, never refreshed', async () => {
    await start('', false);
    fake.personal.set('glpat-ann-1', 'ann');
    const response = await post('gitlab', { token: ' glpat-ann-1 ', next: '/runs/x' });
    const text = await response.text();
    expect(response.status).toBe(201);
    expect(JSON.parse(text)).toEqual({ url: '/runs/x' });
    expect(text).not.toContain('glpat-ann-1');
    const cookie = (
      response.headers.getSetCookie().find((entry) => entry.startsWith('swarmloop_session=')) ?? ''
    ).split(';')[0];
    expect(cookie).toMatch(/^swarmloop_session=[0-9a-f]{64}$/);
    expect(await (await fetch(`${app.url}/auth/me`, { headers: { cookie } })).json()).toMatchObject({
      user: 'ann',
      provider: 'gitlab',
      role: 'admin',
    });
    expect(await connections().health('gitlab', 'ann')).toMatchObject({ status: 'ok', expiresAt: null });
    expect(await connections().tokenFor('gitlab', 'ann')).toBe('glpat-ann-1');
  });

  it('replaces the stored token when the same person signs in again with a new one', async () => {
    await start('gitlab:ann');
    fake.personal.set('glpat-ann-1', 'ann');
    fake.personal.set('glpat-ann-2', 'ann');
    expect((await post('gitlab', { token: 'glpat-ann-1' })).status).toBe(201);
    expect((await post('gitlab', { token: 'glpat-ann-2' })).status).toBe(201);
    expect(await connections().tokenFor('gitlab', 'ann')).toBe('glpat-ann-2');
  });

  it('answers 400 when the host refuses the token, and signs nobody in', async () => {
    await start();
    const response = await post('gitlab', { token: 'glpat-unknown' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: 'GitLab did not accept this token' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await connections().health('gitlab', 'ann')).toBeNull();
  });

  it('refuses an account SWARMLOOP_ALLOW does not list, as the OAuth login does', async () => {
    await start('gitlab:someone-else');
    fake.personal.set('glpat-ann-1', 'ann');
    const response = await post('gitlab', { token: 'glpat-ann-1', next: '/runs/x' });
    const { url } = (await response.json()) as { url: string };
    const target = new URL(url, 'http://swarmloop.test');
    expect(target.pathname).toBe('/login');
    expect(Object.fromEntries(target.searchParams)).toMatchObject({ error: 'refused', host: 'gitlab', account: 'ann' });
    expect(response.headers.getSetCookie().some((entry) => entry.startsWith('swarmloop_session='))).toBe(false);
  });

  it('answers 404 for a host that does not sign in with a token', async () => {
    await start();
    expect((await post('github', { token: 'ghp_x' })).status).toBe(404);
  });
});
