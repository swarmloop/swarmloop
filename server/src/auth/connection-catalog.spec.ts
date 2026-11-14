import type { ConnectionCard, IntegrationCardsView } from '../contract/connections';
import { DataSource } from 'typeorm';
import type { Connection } from '../integrations/connection';
import { fakeConnection } from '../testing/fake-connection';
import { call, start, type Started } from './connection-catalog.spec-helpers';
import { SandboxConnectionProbe } from './connection-probe';
import { ConnectionsService } from './connections.service';
import { startFakeHosts, type FakeHost } from './fake-hosts.spec-helpers';

const HOUR = 3600 * 1000;
const SECRET = 'sk-fake-secret-1234';

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

  describe('with only the server default', () => {
    let tested: Record<string, string>[];

    beforeEach(async () => {
      await started.close();
      tested = [];
      started = await start({ ANTHROPIC_API_KEY: 'from-env' }, [
        {
          ...fakeConnection({ id: 'fakeai', fields: ['apiKey'], envName: 'ANTHROPIC_API_KEY' }),
          test: (fields) => {
            tested.push(fields);
            return Promise.resolve(result);
          },
        },
      ]);
    });

    it('tests the env fields, stores nothing and leaves the card as it was', async () => {
      const response = await call(`${started.url}/fakeai/test`, 'alice', 'POST');
      expect(await response.json()).toMatchObject({ status: 'connected', serverDefault: true, reason: null });
      expect(tested).toEqual([{ ANTHROPIC_API_KEY: 'from-env' }]);
      expect(await rows()).toEqual([]);
    });

    it('shows the reason of a failed test on the card it answers, without storing it', async () => {
      result = { ok: false, message: 'the server key was revoked' };
      const answer = (await (await call(`${started.url}/fakeai/test`, 'alice', 'POST')).json()) as ConnectionCard;
      expect(answer).toMatchObject({ status: 'attention', reason: 'the server key was revoked' });
      expect(await rows()).toEqual([]);
      expect(await card()).toMatchObject({ status: 'connected', reason: null, serverDefault: true });
    });

    it("tests the person's own fields rather than the env ones once they stored them", async () => {
      await call(`${started.url}/fakeai`, 'alice', 'PUT', { fields: { apiKey: SECRET } });
      tested.length = 0;
      await call(`${started.url}/fakeai/test`, 'alice', 'POST');
      expect(tested).toEqual([{ apiKey: SECRET }]);
    });
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
  /** The code host cards; the tracker and page cards of the default list are not what this group is about. */
  const cards = async (actor = 'alice') =>
    ((await (await call(started.url, actor)).json()) as IntegrationCardsView).cards.filter((item) =>
      ['github', 'gitlab'].includes(item.id),
    );
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
    const hosts = (await cards()).filter((item) => item.id === 'github' || item.id === 'gitlab');
    expect(hosts.map((item) => [item.id, item.flows])).toEqual([
      ['github', [expect.objectContaining({ kind: 'redirect', url: '/auth/github/login', fields: [] })]],
      ['gitlab', [expect.objectContaining({ kind: 'redirect', url: '/auth/gitlab/login', fields: [] })]],
    ]);
    expect(await github()).toMatchObject({ status: 'not-connected', serverDefault: true });
    expect(hosts[1]).toMatchObject({ serverDefault: false });
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

  it('test the server token when the person has no connection of their own', async () => {
    const tested = (await (await call(`${started.url}/github/test`, 'alice', 'POST')).json()) as ConnectionCard;
    expect(tested).toMatchObject({ status: 'not-connected', serverDefault: true, reason: null });
    expect(fake.seen.at(-1)).toMatchObject({ path: '/api/v3/user', authorization: 'Bearer env-token' });
    expect((await call(`${started.url}/gitlab/test`, 'alice', 'POST')).status).toBe(400);
  });

  it("show the host's status text when it rejects the server token, and leave the card as it was", async () => {
    const gone = await start({ GITLAB_BASE_URL: `${fake.url}/gone`, GITLAB_TOKEN: 'env-token' });
    try {
      const tested = (await (await call(`${gone.url}/gitlab/test`, 'alice', 'POST')).json()) as ConnectionCard;
      expect(tested).toMatchObject({ status: 'attention', reason: 'GitLab answered 404' });
      const listed = ((await (await call(gone.url, 'alice')).json()) as IntegrationCardsView).cards;
      expect(listed.find((item) => item.id === 'gitlab')).toMatchObject({
        status: 'not-connected',
        serverDefault: true,
        reason: null,
      });
    } finally {
      await gone.close();
    }
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
