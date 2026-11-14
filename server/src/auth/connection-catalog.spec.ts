import { EventEmitter } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SwarmloopConfigModule } from '../config/config.module';
import { Clock } from '../core/clock';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { ConnectionCard, IntegrationCardsView } from '../contract/connections';
import { HistoryModule } from '../history/history.module';
import type { Connection } from '../integrations/connection';
import { SandboxService } from '../sandbox/sandbox.service';
import { fakeConnection } from '../testing/fake-connection';
import { AuthService } from './auth.service';
import { CONNECTIONS } from './connection-catalog';
import { ConnectionCatalogModule } from './connection-catalog.module';
import { SandboxConnectionProbe } from './connection-probe';
import { ConnectionsService } from './connections.service';
import { startFakeHosts, type FakeHost } from './fake-hosts.spec-helpers';

const HOUR = 3600 * 1000;
const SECRET = 'sk-fake-secret-1234';

/** The settings the server needs to start, with the given ones replacing the defaults. */
function envFile(root: string, overrides: Record<string, string>): string {
  const defaults: Record<string, string> = {
    REQUIREMENTS_VIA: 'direct',
    ISSUE_TRACKER: 'jira',
    JIRA_BASE_URL: '',
    JIRA_EMAIL: '',
    JIRA_API_TOKEN: '',
    GITLAB_BASE_URL: '',
    GITLAB_TOKEN: '',
    GITHUB_BASE_URL: '',
    GITHUB_TOKEN: '',
    CURSOR_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    MAX_AGENT_CALLS: '20',
    MAX_RETURNS: '3',
    MAX_LAUNCHES: '3',
    MAX_RUN_USD: '25',
    IDLE_TIMEOUT_MS: '900000',
    TICK_MS: '15000',
    REQUIREMENTS_TIMEOUT_MS: '600000',
    RESEARCH_TIMEOUT_MS: '900000',
    PLAN_TIMEOUT_MS: '1200000',
    IMPLEMENT_TIMEOUT_MS: '1800000',
    CODE_REVIEW_TIMEOUT_MS: '900000',
    MERGE_REQUEST_TIMEOUT_MS: '600000',
    PIPELINE_TIMEOUT_MS: '1800000',
    PIPELINE_START_TIMEOUT_MS: '180000',
    AGENTS_PLAN: 'cursor:opus-5.5-extra-high',
    AGENTS_IMPLEMENT: 'cursor:grok-4.7',
    AGENTS_REVIEW: 'cursor:opus-5.5-extra-high',
    EPIC_EFFORT: '',
    SPLIT: 'off',
    SWARMLOOP_API_PORT: '0',
    SWARMLOOP_API_HOST: '127.0.0.1',
    SWARMLOOP_ROOT: root,
    SWARMLOOP_TOKEN: 'test-machine-token',
  };
  return `${Object.entries({ ...defaults, ...overrides })
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`;
}

interface Started {
  app: INestApplication;
  url: string;
  clock: FakeClock;
  close(): Promise<void>;
}

/** The catalog over HTTP. The actor is the `x-actor` header, in place of a session: no header is nobody. */
async function start(env: Record<string, string>, connections?: Connection[], models = ''): Promise<Started> {
  const root = await mkdtemp(join(tmpdir(), 'connection-catalog-'));
  await writeFile(join(root, '.env'), envFile(root, env));
  const clock = new FakeClock();
  const sandbox = {
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(models));
        child.emit('close', 0);
      });
      return Promise.resolve(child);
    },
  };
  let builder = Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), HistoryModule, ConnectionCatalogModule],
  })
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(SandboxService)
    .useValue(sandbox)
    .overrideProvider(AuthService)
    .useValue({
      check: (headers: Record<string, string>) => ({ allowed: true, actor: headers['x-actor'] ?? null }),
    });
  if (connections) {
    builder = builder.overrideProvider(CONNECTIONS).useValue(connections);
  }
  const app = (await builder.compile()).createNestApplication();
  await app.listen(0, '127.0.0.1');
  const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
  return {
    app,
    clock,
    url: `http://127.0.0.1:${port}/connections/integrations`,
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const call = (url: string, actor: string | null, method = 'GET', body?: unknown) =>
  fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(actor ? { 'x-actor': actor } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('the integration cards, with a fake connection', () => {
  let started: Started;
  let result: { ok: true; account: string | null } | { ok: false; message: string };
  const connection = (): Connection => ({
    ...fakeConnection({ id: 'fakeai', fields: ['apiKey'], envName: 'ANTHROPIC_API_KEY' }),
    test: () => Promise.resolve(result),
  });
  const card = async (actor = 'alice') =>
    ((await (await call(started.url, actor)).json()) as IntegrationCardsView).cards[0];
  const rows = () => started.app.get(DataSource).query<Record<string, unknown>[]>('SELECT * FROM integration_secrets');

  beforeEach(async () => {
    result = { ok: true, account: 'acct-1' };
    started = await start({}, [connection(), fakeConnection({ id: 'other', fields: ['token'] })]);
  });
  afterEach(() => started.close());

  it('gives one card per listed connection, built only from its description', async () => {
    const view = (await (await call(started.url, 'alice')).json()) as IntegrationCardsView;
    expect(view.cards.map((item) => item.id)).toEqual(['fakeai', 'other']);
    expect(view.cards[0]).toMatchObject({
      label: 'fakeai',
      purpose: 'Fake fakeai',
      status: 'not-connected',
      serverDefault: false,
      flows: [{ kind: 'secret', fields: [{ name: 'apiKey', secret: true }] }],
    });
  });

  it('stores the fields only after the test passed, and shows the last four characters', async () => {
    const response = await call(`${started.url}/fakeai`, 'alice', 'PUT', { fields: { apiKey: SECRET } });
    expect(await response.json()).toMatchObject({ status: 'connected', account: 'acct-1', last4: '1234' });
    expect(await rows()).toHaveLength(1);
    expect(await card('alice')).toMatchObject({ status: 'connected' });
    expect(await card('bob')).toMatchObject({ status: 'not-connected' });
  });

  it('answers the message of a failed test as a 400 and stores nothing', async () => {
    result = { ok: false, message: `bad key ${SECRET}` };
    const response = await call(`${started.url}/fakeai`, 'alice', 'PUT', { fields: { apiKey: SECRET } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: 'bad key ***' });
    expect(await rows()).toEqual([]);
    expect(await card()).toMatchObject({ status: 'not-connected' });
  });

  it('marks a stored credential that now fails as attention, with the reason', async () => {
    await call(`${started.url}/fakeai`, 'alice', 'PUT', { fields: { apiKey: SECRET } });
    result = { ok: false, message: 'key revoked' };
    const tested = (await (await call(`${started.url}/fakeai/test`, 'alice', 'POST')).json()) as ConnectionCard;
    expect(tested).toMatchObject({ status: 'attention', reason: 'key revoked', last4: '1234' });
    expect(await card()).toMatchObject({ status: 'attention', reason: 'key revoked' });
  });

  it('clears the attention when the stored credential passes a test again', async () => {
    await call(`${started.url}/fakeai`, 'alice', 'PUT', { fields: { apiKey: SECRET } });
    result = { ok: false, message: 'key revoked' };
    await call(`${started.url}/fakeai/test`, 'alice', 'POST');
    result = { ok: true, account: 'acct-1' };
    const tested = (await (await call(`${started.url}/fakeai/test`, 'alice', 'POST')).json()) as ConnectionCard;
    expect(tested).toMatchObject({ status: 'connected', reason: null });
    expect(await card()).toMatchObject({ status: 'connected', reason: null });
  });

  it('refuses a test with nothing stored', async () => {
    const response = await call(`${started.url}/fakeai/test`, 'alice', 'POST');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: 'nothing is connected to test' });
  });

  it('clears the connection on disconnect', async () => {
    await call(`${started.url}/fakeai`, 'alice', 'PUT', { fields: { apiKey: SECRET } });
    expect(await (await call(`${started.url}/fakeai`, 'alice', 'DELETE')).json()).toEqual({ ok: true });
    expect(await rows()).toEqual([]);
    expect(await card()).toMatchObject({ status: 'not-connected', last4: null });
  });

  it('refuses a write from the machine or nobody, and an unknown connection', async () => {
    for (const actor of ['machine', null]) {
      for (const [path, method] of [
        ['fakeai', 'PUT'],
        ['fakeai/test', 'POST'],
        ['fakeai', 'DELETE'],
      ]) {
        expect((await call(`${started.url}/${path}`, actor, method, { fields: { apiKey: SECRET } })).status).toBe(403);
      }
    }
    expect((await call(`${started.url}/nothing`, 'alice', 'DELETE')).status).toBe(404);
    expect(await rows()).toEqual([]);
  });

  it('holds the plain secret only in the sealed column', async () => {
    await call(`${started.url}/fakeai`, 'alice', 'PUT', { fields: { apiKey: SECRET } });
    const db = started.app.get(DataSource);
    const tables = await db.query<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table'`);
    for (const { name } of tables) {
      const dump = JSON.stringify(await db.query(`SELECT * FROM "${name}"`));
      expect([name, dump.includes(SECRET)]).toEqual([name, false]);
    }
  });
});

describe('the probe', () => {
  let started: Started;
  let fake: FakeHost;

  beforeEach(async () => {
    fake = await startFakeHosts();
    started = await start({}, [], 'grok-4.7 - Grok 4.7\n\n  composer-2 - Composer 2 \n');
  });
  afterEach(async () => {
    await started.close();
    await fake.stop();
  });

  it('lists the trimmed non-empty lines the model list of the image prints', async () => {
    const probe = started.app.get(SandboxConnectionProbe);
    expect(await probe.listModels('cursor', { cursorKey: 'key' })).toEqual([
      'grok-4.7 - Grok 4.7',
      'composer-2 - Composer 2',
    ]);
  });

  it('answers the status and the body of one request', async () => {
    const probe = started.app.get(SandboxConnectionProbe);
    const answer = await probe.request(`${fake.url}/api/v4/user`, { Authorization: 'Bearer ghu_carol_1' });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ username: 'carol' });
    expect((await probe.request(`${fake.url}/missing`, {})).status).toBe(404);
  });
});

describe('the GitHub and GitLab cards', () => {
  let started: Started;
  let fake: FakeHost;
  const cards = async (actor = 'alice') =>
    ((await (await call(started.url, actor)).json()) as IntegrationCardsView).cards;
  const github = async () => (await cards()).find((item) => item.id === 'github') as ConnectionCard;
  const connect = (host: 'github' | 'gitlab', login: string) =>
    started.app
      .get(ConnectionsService)
      .connect(host, login, { accessToken: `ghu_${login}_1`, refreshToken: `ghr_${login}_1`, expiresIn: 3600 });

  beforeEach(async () => {
    fake = await startFakeHosts();
    started = await start({ GITHUB_BASE_URL: fake.url, GITLAB_BASE_URL: fake.url, GITHUB_TOKEN: 'env-token' });
  });
  afterEach(async () => {
    await started.close();
    await fake.stop();
  });

  it('carry the redirect flow to the reconnect url', async () => {
    expect((await cards()).map((item) => [item.id, item.flows])).toEqual([
      ['github', [expect.objectContaining({ kind: 'redirect', url: '/auth/github/login', fields: [] })]],
      ['gitlab', [expect.objectContaining({ kind: 'redirect', url: '/auth/gitlab/login', fields: [] })]],
    ]);
    expect(await github()).toMatchObject({ status: 'not-connected', serverDefault: true });
    expect((await cards())[1]).toMatchObject({ serverDefault: false });
  });

  it('take their status from the health of the connection', async () => {
    await connect('github', 'alice');
    expect(await github()).toMatchObject({ status: 'connected', account: 'alice', reason: null });
    fake.revoked.add('ghr_alice_1');
    started.clock.advance(HOUR);
    await expect(started.app.get(ConnectionsService).tokenFor('github', 'alice')).rejects.toThrow();
    expect(await github()).toMatchObject({ status: 'attention', account: 'alice' });
  });

  it('test by reading the account from the host', async () => {
    await connect('github', 'alice');
    await connect('gitlab', 'bob');
    const github = (await (await call(`${started.url}/github/test`, 'alice', 'POST')).json()) as ConnectionCard;
    expect(github).toMatchObject({ status: 'connected', account: 'alice' });
    const gitlab = (await (await call(`${started.url}/gitlab/test`, 'bob', 'POST')).json()) as ConnectionCard;
    expect(gitlab).toMatchObject({ status: 'connected', account: 'bob' });
    expect(fake.seen.at(-1)).toMatchObject({ path: '/api/v4/user', authorization: 'Bearer ghu_bob_1' });
  });

  it('show the reason when the test fails, and refuse a paste', async () => {
    await connect('github', 'alice');
    fake.revoked.add('ghr_alice_1');
    started.clock.advance(HOUR);
    const tested = (await (await call(`${started.url}/github/test`, 'alice', 'POST')).json()) as ConnectionCard;
    expect(tested).toMatchObject({ status: 'attention', reason: 'Reconnect GitHub' });
    const put = await call(`${started.url}/github`, 'alice', 'PUT', { fields: { token: 'x' } });
    expect(put.status).toBe(400);
    expect(await put.json()).toMatchObject({ message: 'connect GitHub through its sign-in' });
  });

  it("show the host's status text when it rejects the token", async () => {
    const gone = await start({ GITLAB_BASE_URL: `${fake.url}/gone` });
    try {
      await gone.app
        .get(ConnectionsService)
        .connect('gitlab', 'bob', { accessToken: 'ghu_bob_1', refreshToken: 'ghr_bob_1', expiresIn: 3600 });
      const tested = (await (await call(`${gone.url}/gitlab/test`, 'bob', 'POST')).json()) as ConnectionCard;
      expect(tested).toMatchObject({ status: 'attention', reason: 'GitLab answered 404' });
    } finally {
      await gone.close();
    }
  });

  it('disconnect through the store of the host', async () => {
    await connect('github', 'alice');
    await call(`${started.url}/github`, 'alice', 'DELETE');
    expect(await github()).toMatchObject({ status: 'not-connected' });
    expect(await started.app.get(ConnectionsService).health('github', 'alice')).toBeNull();
  });
});
