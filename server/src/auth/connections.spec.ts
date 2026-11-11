import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { GitAuthError } from '../core/swarmloop-error';
import { CommandService } from '../pipeline/command.service';
import { Reconciler } from '../pipeline/reconciler';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { RemoteRepositories } from '../steps/prepare/remote-repositories.service';
import { createTestApp, type TestApp } from '../testing/test-app';
import { ConnectionsService } from './connections.service';
import { startFakeHosts, type FakeHost } from './fake-hosts.spec-helpers';
import { SecretBox, secretKey } from './secret-box';

const TOKEN = 'machine-secret';
const HOUR = 3600 * 1000;

describe('connect GitHub: the app from a manifest, and the tokens of each person', () => {
  let fake: FakeHost;
  let app: TestApp;
  const authed = { authorization: `Bearer ${TOKEN}` };

  beforeEach(async () => {
    fake = await startFakeHosts();
    app = await createTestApp({
      env: {
        GITHUB_BASE_URL: fake.url,
        GITHUB_TOKEN: 'env-token',
        SWARMLOOP_ALLOW: 'github:alice,github:bob',
        SWARMLOOP_TOKEN: TOKEN,
      },
    });
  });
  afterEach(async () => {
    await app.close();
    await fake.stop();
  });

  /** The first-run screen's work: the manifest, GitHub's redirect with a code, and the exchange. */
  async function makeApp(): Promise<void> {
    const manifest = await fetch(`${app.url}/auth/github/manifest`);
    const state = new URL(((await manifest.json()) as { action: string }).action).searchParams.get('state') ?? '';
    const created = await fetch(`${app.url}/auth/github/created?code=manifest-code&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: `swarmloop_state=${state}` },
    });
    expect(created.status).toBe(302);
  }

  /** Signs in with the app, which also keeps the person's tokens. Answers the session cookie. */
  async function signIn(user: string): Promise<string> {
    const start = await fetch(`${app.url}/auth/github/login`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const callback = await fetch(`${app.url}/auth/github/callback?code=${user}&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: `swarmloop_state=${state}` },
    });
    expect(callback.status).toBe(302);
    return (
      callback.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('swarmloop_session='))
        ?.split(';')[0] ?? ''
    );
  }

  const registry = () => app.app.get(CodeHostRegistry);
  const connections = () => app.app.get(ConnectionsService);
  const lastAuthorization = () => fake.seen[fake.seen.length - 1].authorization;

  it('offers the first-run routes only while no login exists, and only to this machine', async () => {
    expect(await (await fetch(`${app.url}/auth/first-run`)).json()).toEqual({ login: false });
    const response = await fetch(`${app.url}/auth/github/manifest?org=acme`);
    const { action, manifest } = (await response.json()) as { action: string; manifest: Record<string, unknown> };
    const target = new URL(action);
    expect(target.origin + target.pathname).toBe(`${fake.url}/organizations/acme/settings/apps/new`);
    expect(manifest).toMatchObject({
      name: 'swarmloop-127.0.0.1',
      url: 'http://127.0.0.1:3921',
      redirect_url: 'http://127.0.0.1:3921/auth/github/created',
      callback_urls: ['http://127.0.0.1:3921/auth/github/callback'],
      request_oauth_on_install: true,
      default_permissions: {
        contents: 'write',
        pull_requests: 'write',
        workflows: 'write',
        administration: 'write',
        checks: 'read',
        actions: 'write',
        statuses: 'read',
        metadata: 'read',
      },
    });
    expect(manifest.hook_attributes).toMatchObject({ active: false });
    const remote = await fetch(`${app.url}/auth/github/manifest`, { headers: { 'x-forwarded-host': 'panel.example' } });
    expect(remote.status).toBe(403);
    expect(
      (await fetch(`${app.url}/auth/github/manifest`, { headers: { ...authed, 'x-forwarded-host': 'panel.example' } }))
        .status,
    ).toBe(200);
    expect((await fetch(`${app.url}/runs`)).status).toBe(401);
  });

  it('stores the app encrypted, shows no secret on any route, and refuses a second app', async () => {
    await makeApp();
    expect(await (await fetch(`${app.url}/auth/first-run`)).json()).toEqual({ login: true });
    expect((await fetch(`${app.url}/auth/github/manifest`)).status).toBe(403);
    expect((await fetch(`${app.url}/auth/github/manifest`, { headers: authed })).status).toBe(403);
    const [row] = await app.app.get(DataSource).query<Record<string, string>[]>(`SELECT * FROM host_apps`);
    expect(row).toMatchObject({ id: 'github', app_id: '42', slug: 'swarmloop-app', client_id: 'Iv.fake' });
    expect(row.client_secret).not.toBe('fake-client-secret');
    expect(row.private_key).not.toContain('FAKE KEY');
    const box = new SecretBox(secretKey(app.root, ''));
    expect(box.open(row.client_secret)).toBe('fake-client-secret');
    for (const path of ['/auth/providers', '/auth/first-run', '/connections']) {
      const body = await (await fetch(`${app.url}${path}`, { headers: authed })).text();
      expect(body).not.toContain('fake-client-secret');
      expect(body).not.toContain('FAKE KEY');
    }
  });

  it('keeps the user token and the installation of a person who installs and authorizes, and shows no token', async () => {
    await makeApp();
    const alice = await signIn('alice');
    const view = (await (await fetch(`${app.url}/connections`, { headers: { cookie: alice } })).json()) as {
      connections: {
        host: string;
        account: string | null;
        repositories: string[];
        selection: string;
        health: { status: string; expiresAt: string };
      }[];
    };
    const github = view.connections.find((item) => item.host === 'github');
    expect(github).toMatchObject({
      account: 'alice',
      repositories: ['alice/site'],
      selection: 'selected',
      health: { status: 'ok' },
      app: { name: 'swarmloop-app', clientId: 'Iv.fake' },
    });
    expect(JSON.stringify(view)).not.toMatch(/ghu_|ghr_|fake-client-secret/);
    const bob = (await (
      await fetch(`${app.url}/connections`, { headers: { cookie: await signIn('bob') } })
    ).json()) as typeof view;
    expect(bob.connections.find((item) => item.host === 'github')?.account).toBe('bob');
  });

  it('disconnects: the stored tokens are deleted', async () => {
    await makeApp();
    const alice = await signIn('alice');
    const out = await fetch(`${app.url}/connections/github`, { method: 'DELETE', headers: { cookie: alice } });
    expect(out.status).toBe(200);
    expect(await connections().health('github', 'alice')).toBeNull();
    expect(await app.app.get(DataSource).query(`SELECT * FROM connections`)).toEqual([]);
  });

  it('runs of person A call the host with the token of A, those of B with B, and a CLI run with the env token', async () => {
    await makeApp();
    await signIn('alice');
    await signIn('bob');
    const draft = {
      project: 'acme/site',
      source: 'feature',
      target: 'main',
      title: 'Title',
      summary: 'Body',
      draft: true,
    };
    for (const [startedBy, token] of [
      ['alice', 'Bearer ghu_alice_1'],
      ['bob', 'Bearer ghu_bob_1'],
      ['machine', 'Bearer env-token'],
      [null, 'Bearer env-token'],
    ] as const) {
      const host = (await registry().forRun(startedBy, 'github')).byName('github');
      await host.openMergeRequest(draft);
      expect(lastAuthorization()).toBe(token);
    }
    const origin = `${fake.url}/acme/site.git`;
    expect((await registry().forRun('alice')).pushAuth(origin).url).toContain('ghu_alice_1');
    expect((await registry().forRun('bob')).pushAuth(origin).url).toContain('ghu_bob_1');
  });

  it('refreshes the token before it ends, once for concurrent calls', async () => {
    await makeApp();
    await signIn('alice');
    const refreshes = () => fake.seen.filter((call) => call.body.includes('refresh_token')).length;
    expect(await connections().tokenFor('github', 'alice')).toBe('ghu_alice_1');
    expect(refreshes()).toBe(0);
    app.clock.advance(HOUR - 60 * 1000);
    const tokens = await Promise.all([1, 2, 3].map(() => connections().tokenFor('github', 'alice')));
    expect(tokens).toEqual(['ghu_alice_2', 'ghu_alice_2', 'ghu_alice_2']);
    expect(refreshes()).toBe(1);
    expect((await connections().health('github', 'alice'))?.status).toBe('ok');
  });

  it('marks a revoked connection broken and refuses its runs with GitAuthError until the person reconnects', async () => {
    await makeApp();
    await signIn('alice');
    fake.revoked.add('ghr_alice_1');
    app.clock.advance(HOUR);
    await expect(connections().tokenFor('github', 'alice')).rejects.toThrow(GitAuthError);
    expect((await connections().health('github', 'alice'))?.status).toBe('broken');
    await expect(registry().forRun('alice', 'github')).rejects.toThrow('Reconnect GitHub');
    await signIn('alice');
    expect((await connections().health('github', 'alice'))?.status).toBe('ok');
    await expect(registry().forRun('alice', 'github')).resolves.toBeDefined();
  });

  it('does not let a stranger in after Disconnect when nobody is listed, except on this machine', async () => {
    await app.close();
    app = await createTestApp({ env: { GITHUB_BASE_URL: fake.url, SWARMLOOP_TOKEN: TOKEN } });
    await makeApp();
    const alice = await signIn('alice');
    await fetch(`${app.url}/connections/github`, { method: 'DELETE', headers: { cookie: alice } });
    const start = await fetch(`${app.url}/auth/github/login`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const remote = await fetch(`${app.url}/auth/github/callback?code=mallory&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: `swarmloop_state=${state}`, 'x-forwarded-host': 'panel.example' },
    });
    expect(remote.status).toBe(403);
  });

  it('keeps a broken connection on one host from stopping a run on the other', async () => {
    await makeApp();
    await signIn('alice');
    await connections().connect('gitlab', 'alice', { accessToken: 'gl', refreshToken: 'glr', expiresIn: 1 });
    app.clock.advance(10 * 1000);
    await expect(registry().forRun('alice', 'gitlab')).rejects.toThrow(GitAuthError);
    await registry().forRun('alice', 'github');
    await registry().forRun('alice');
    expect((await registry().forRun('alice')).credentials('github').token).toBe('ghu_alice_1');
  });

  it('adds a repository created on a selected-repositories installation, with the token of the person', async () => {
    await makeApp();
    await signIn('alice');
    await connections().addRepository('alice', 'alice/new');
    const put = fake.seen.find((call) => call.method === 'PUT');
    expect(put).toMatchObject({
      path: '/api/v3/user/installations/7/repositories/99',
      authorization: 'Bearer ghu_alice_1',
    });
  });

  it('refuses a clone when there is no token at all, with the reason', async () => {
    const bare = await createTestApp({ env: { GITHUB_BASE_URL: fake.url, SWARMLOOP_TOKEN: TOKEN } });
    try {
      await expect(bare.app.get(RemoteRepositories, { strict: false }).clone('site', null)).rejects.toThrow(
        'GITHUB_TOKEN or GITLAB_TOKEN is missing: Connect GitHub or GitLab',
      );
    } finally {
      await bare.close();
    }
  });

  it('a run that lost its token waits with GIT_AUTH and goes on by itself after the person reconnects', async () => {
    await app.close();
    let failing = true;
    app = await createTestApp({
      env: {
        GITHUB_BASE_URL: fake.url,
        SWARMLOOP_ALLOW: 'github:alice',
        SWARMLOOP_TOKEN: TOKEN,
      },
      runner: {
        steps: [],
        run: (step: string) =>
          failing && step === 'prepare' ? Promise.reject(new GitAuthError('Reconnect GitHub')) : Promise.resolve(),
      },
    });
    await makeApp();
    const cookie = await signIn('alice');
    const headers = { cookie, 'content-type': 'application/json' };
    const created = await fetch(`${app.url}/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'proj-9', prompt: 'Ship it', projects: ['demo'] }),
    });
    expect(created.status).toBeLessThan(300);
    await app.app.get(CommandService).idle();
    await app.pipeline.whenIdle('proj-9');
    const stateOf = async () =>
      (await (await fetch(`${app.url}/runs/proj-9`, { headers: { cookie } })).json()) as {
        state: string;
        stateReason: { code: string; message: string } | null;
      };
    expect(await stateOf()).toMatchObject({
      state: 'waiting',
      stateReason: { code: 'GIT_AUTH', message: expect.stringContaining('Reconnect GitHub') },
    });

    failing = false;
    await app.app.get(Reconciler).resumeGitAuth();
    await app.app.get(CommandService).idle();
    await app.pipeline.whenIdle('proj-9');
    expect((await stateOf()).state).not.toBe('waiting');
  });

  it('keeps every token and secret out of every stored file and table of a fixture run', async () => {
    await makeApp();
    const alice = await signIn('alice');
    await signIn('bob');
    await fetch(`${app.url}/runs`, {
      method: 'POST',
      headers: { cookie: alice, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'proj-1', prompt: 'Ship it', projects: ['demo'] }),
    });
    await app.app.get(CommandService).idle();
    await app.pipeline.whenIdle('proj-1');
    await (await registry().forRun('alice', 'github')).byName('github').readCurrentUser();

    const secrets = [...new Set(fake.secrets)];
    const files = filesUnder(app.root).filter((file) => !file.endsWith('.env') && !file.endsWith('/data/secret'));
    expect(files.some((file) => file.endsWith('.git/config') || file.includes('data'))).toBe(true);
    for (const file of files) {
      const bytes = readFileSync(file);
      for (const secret of secrets) {
        expect([file, bytes.includes(secret)]).toEqual([file, false]);
      }
    }
    const db = app.app.get(DataSource);
    const tables = await db.query<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table'`);
    for (const { name } of tables) {
      const dump = JSON.stringify(await db.query(`SELECT * FROM "${name}"`));
      for (const secret of secrets) {
        expect([name, dump.includes(secret)]).toEqual([name, false]);
      }
    }
    const [stored] = await db.query<Record<string, string>[]>(`SELECT * FROM connections WHERE login = 'alice'`);
    const box = new SecretBox(secretKey(app.root, ''));
    expect(box.open(stored.access_token)).toMatch(/^ghu_alice_/);
    expect(box.open(stored.refresh_token)).toMatch(/^ghr_alice_/);
  });
});

describe('connect GitLab', () => {
  it('stores the OAuth application, asks for read_user api write_repository and keeps the tokens of the person', async () => {
    const fake = await startFakeHosts();
    const app = await createTestApp({
      env: { GITLAB_BASE_URL: fake.url, SWARMLOOP_ALLOW: 'gitlab:carol', SWARMLOOP_TOKEN: TOKEN },
    });
    try {
      const saved = await fetch(`${app.url}/auth/gitlab/application`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: 'gl-client', clientSecret: 'gl-secret' }),
      });
      expect(saved.status).toBeLessThan(300);
      const start = await fetch(`${app.url}/auth/gitlab/login`, { redirect: 'manual' });
      const target = new URL(start.headers.get('location') ?? '');
      expect(target.searchParams.get('scope')).toBe('read_user api write_repository');
      const state = target.searchParams.get('state') ?? '';
      const callback = await fetch(`${app.url}/auth/gitlab/callback?code=carol&state=${state}`, {
        redirect: 'manual',
        headers: { cookie: `swarmloop_state=${state}` },
      });
      expect(callback.status).toBe(302);
      const host = (await app.app.get(CodeHostRegistry).forRun('carol', 'gitlab')).byName('gitlab');
      await host.readCurrentUser();
      expect(fake.seen[fake.seen.length - 1]).toMatchObject({ authorization: 'Bearer ghu_carol_1' });
      const [row] = await app.app.get(DataSource).query<Record<string, string>[]>(`SELECT * FROM host_apps`);
      expect(row.client_secret).not.toBe('gl-secret');
    } finally {
      await app.close();
      await fake.stop();
    }
  });
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    return statSync(path).isDirectory() ? filesUnder(path) : existsSync(path) ? [path] : [];
  });
}
