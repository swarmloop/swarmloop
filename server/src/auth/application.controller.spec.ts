import { FAKE_MODEL_KEY } from '../testing/env.spec-helpers';
import { createTestApp, type TestApp } from '../testing/test-app';
import { ConnectionsService } from './connections.service';
import { startFakeHosts, KNOWN_GITLAB_CLIENT, ODD_GITLAB_CLIENT, type FakeHost } from './fake-hosts.spec-helpers';
import { HostAppsService } from './host-apps.service';

const JSON_HEADERS = { 'content-type': 'application/json', 'x-swarmloop': '1' };

describe('the GitLab application: store, check and replace', () => {
  let fake: FakeHost;
  let app: TestApp;

  async function start(env: Record<string, string> = {}): Promise<void> {
    fake = await startFakeHosts();
    app = await createTestApp({
      env: {
        ...FAKE_MODEL_KEY,
        GITHUB_OAUTH_CLIENT_ID: '',
        GITHUB_OAUTH_CLIENT_SECRET: '',
        GITLAB_OAUTH_CLIENT_ID: '',
        GITLAB_OAUTH_CLIENT_SECRET: '',
        GITLAB_BASE_URL: fake.url,
        SWARMLOOP_PUBLIC_URL: 'http://localhost:4000/',
        SWARMLOOP_ALLOW: 'gitlab:carol,gitlab:ann',
        ...env,
      },
    });
  }

  const post = (clientId: string, clientSecret: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${app.url}/auth/gitlab/application`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...headers },
      body: JSON.stringify({ clientId, clientSecret }),
    });

  const stored = () => app.app.get(HostAppsService).find('gitlab');
  const connections = () => app.app.get(ConnectionsService);

  /** An OAuth sign-in through the stored application: the connection keeps a refresh token. */
  async function signInWithApplication(user: string): Promise<void> {
    const begin = await fetch(`${app.url}/auth/gitlab/login`, { redirect: 'manual' });
    const state = new URL(begin.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const callback = await fetch(`${app.url}/auth/gitlab/callback?code=${user}&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: `swarmloop_state=${state}` },
    });
    expect(callback.headers.get('location')).toBe('/');
  }

  afterEach(async () => {
    await app.close();
    await fake.stop();
  });

  it('lists the application to register with its page, the callback and the scopes of the authorize request', async () => {
    await start();
    const view = (await (await fetch(`${app.url}/auth/providers`)).json()) as { applications: unknown[] };
    expect(view.applications).toEqual([
      {
        provider: 'gitlab',
        page: `${fake.url}/-/user_settings/applications`,
        callback: 'http://localhost:4000/auth/gitlab/callback',
        scopes: ['read_user', 'api', 'write_repository'],
      },
    ]);
  });

  it('refuses an application the host rejects, says which words, and stores nothing', async () => {
    await start();
    const response = await post('wrong-id', 'wrong-secret');
    expect(response.status).toBe(422);
    const { message } = (await response.json()) as { message: string };
    expect(message).toBe('GitLab did not accept this Application ID and Secret. Check both fields.');
    expect(stored()).toBeNull();
  });

  it('asks for both fields, and stores an application the host knows as made on first run', async () => {
    await start();
    expect((await post('', 'secret')).status).toBe(400);
    expect((await post(KNOWN_GITLAB_CLIENT, '')).status).toBe(400);
    expect((await post(KNOWN_GITLAB_CLIENT, 'secret')).status).toBe(201);
    expect(stored()).toMatchObject({ clientId: KNOWN_GITLAB_CLIENT, clientSecret: 'secret', madeBy: 'first-run' });
  });

  it('answers 502 with the host words when the host answers something else, and stores nothing', async () => {
    await start();
    const response = await post(ODD_GITLAB_CLIENT, 'secret');
    expect(response.status).toBe(502);
    expect(((await response.json()) as { message: string }).message).toContain('GitLab answered HTTP 400');
    expect(stored()).toBeNull();
  });

  it('lets this machine replace an application nobody has signed in through, and drops nothing it did not issue', async () => {
    await start();
    expect((await post(KNOWN_GITLAB_CLIENT, 'first')).status).toBe(201);
    expect((await post(KNOWN_GITLAB_CLIENT, 'second')).status).toBe(201);
    expect(stored()).toMatchObject({ clientSecret: 'second', madeBy: 'first-run' });
  });

  it('lets only the maker or an admin replace it, and names who', async () => {
    await start();
    await post(KNOWN_GITLAB_CLIENT, 'first');
    expect((await post(KNOWN_GITLAB_CLIENT, 'second', app.auth)).status).toBe(201);
    expect(stored()?.madeBy).toBe('test-admin');
    const member = await post(KNOWN_GITLAB_CLIENT, 'third', await app.personToken('mia'));
    expect(member.status).toBe(403);
    expect(((await member.json()) as { message: string }).message).toBe(
      'Only test-admin or an admin can replace this application. Sign in with a token, then use Connections.',
    );
    expect((await post(KNOWN_GITLAB_CLIENT, 'third')).status).toBe(403);
    expect(stored()?.clientSecret).toBe('second');
  });

  it('says to change .env when the application comes from the environment', async () => {
    await start({ GITLAB_OAUTH_CLIENT_ID: KNOWN_GITLAB_CLIENT, GITLAB_OAUTH_CLIENT_SECRET: 'env-secret' });
    const response = await post(KNOWN_GITLAB_CLIENT, 'secret');
    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toBe(
      'This GitLab application comes from GITLAB_OAUTH_CLIENT_ID and GITLAB_OAUTH_CLIENT_SECRET: change them in .env and restart the server.',
    );
  });

  it("keeps the token sign-ins and drops the OAuth connections when an admin's replace is stored", async () => {
    await start();
    await post(KNOWN_GITLAB_CLIENT, 'first');
    await signInWithApplication('carol');
    fake.personal.set('glpat-ann-1', 'ann');
    const token = await fetch(`${app.url}/auth/gitlab/token`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: 'glpat-ann-1' }),
    });
    expect(token.status).toBe(201);
    expect(await connections().grantLogins('gitlab')).toEqual(['carol']);
    expect(await connections().loginsOn('gitlab')).toEqual(['ann', 'carol']);
    expect((await post(KNOWN_GITLAB_CLIENT, 'second', app.auth)).status).toBe(201);
    expect(await connections().loginsOn('gitlab')).toEqual(['ann']);
  });
});
