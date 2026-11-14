import type { ConnectionCard, IntegrationCardsView } from '../../../contract/connections';
import { DataSource } from 'typeorm';
import { call, start, type Started } from '../../../auth/connection-catalog.spec-helpers';
import { startFakeModelApi, type FakeModelApi } from '../../../testing/fake-model-api';
import { ClaudeConnection } from './claude-connection';

const GOOD = 'sk-good-key-1234';
const BAD = 'sk-bad-key-9876';

describe('the Claude connection', () => {
  let started: Started;
  let api: FakeModelApi;
  const put = (key: string) => call(`${started.url}/claude`, 'alice', 'PUT', { fields: { ANTHROPIC_API_KEY: key } });
  const rows = () => started.app.get(DataSource).query<Record<string, unknown>[]>('SELECT * FROM integration_secrets');

  beforeEach(async () => {
    api = await startFakeModelApi(GOOD);
    started = await start({}, [new ClaudeConnection(api.url)]);
  });
  afterEach(async () => {
    await started.close();
    await api.close();
  });

  it('stores a key that passes the test under its env name, and sends the header the provider needs', async () => {
    const response = await put(GOOD);
    expect(await response.json()).toMatchObject({ id: 'claude', status: 'connected', last4: '1234' });
    expect(await rows()).toMatchObject([{ connection: 'claude' }]);
    expect(api.seen[0]).toMatchObject({ 'x-api-key': GOOD, 'anthropic-version': expect.any(String) });
    const card = (await (await call(started.url, 'alice')).json()) as IntegrationCardsView;
    expect(card.cards[0].flows[0].fields.map((field) => field.name)).toEqual(['ANTHROPIC_API_KEY']);
  });

  it("answers a rejected key with the provider's text and stores nothing", async () => {
    const response = await put(BAD);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toBe('The key was rejected by the fake model API');
    expect(body.message).not.toContain(BAD);
    expect(await rows()).toEqual([]);
  });

  it('shows the server default when the env holds a credential', async () => {
    await started.close();
    started = await start({ ANTHROPIC_API_KEY: 'from-env' }, [new ClaudeConnection(api.url)]);
    const view = (await (await call(started.url, 'alice')).json()) as { cards: ConnectionCard[] };
    expect(view.cards[0]).toMatchObject({ serverDefault: true });
  });

  it('stores the token that a sign-in made, tested as a bearer token with the OAuth header', async () => {
    const token = 'sk-ant-oat01-signed-in-5555';
    await api.close();
    api = await startFakeModelApi(token);
    await started.close();
    started = await start({}, [new ClaudeConnection(api.url)]);
    const response = await call(`${started.url}/claude`, 'alice', 'PUT', {
      fields: { CLAUDE_CODE_OAUTH_TOKEN: token },
    });
    expect(await response.json()).toMatchObject({ status: 'connected', last4: '5555' });
    expect(api.seen[0]).toMatchObject({ authorization: `Bearer ${token}`, 'anthropic-beta': expect.any(String) });
    expect(api.seen[0]['x-api-key']).toBeUndefined();
  });

  it('rejects a token with the provider text and stores nothing', async () => {
    const response = await call(`${started.url}/claude`, 'alice', 'PUT', {
      fields: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-other' },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toBe('The key was rejected by the fake model API');
    expect(await rows()).toEqual([]);
  });
});

describe('the Claude sign-in', () => {
  const flow = new ClaudeConnection().signIn();

  it("runs the CLI's own token command", () => {
    expect(flow.command()).toEqual(['claude', 'setup-token']);
    expect(flow.hosts).toContain('claude.ai');
  });

  it('shows the link and asks for the code until the token has printed', () => {
    expect(flow.parse('Starting\n')).toEqual({ link: null, code: null, asksForCode: false, fields: null });
    const asking = flow.parse('Open https://claude.ai/oauth/authorize?x=1\nPaste code here if prompted >');
    expect(asking).toMatchObject({ link: 'https://claude.ai/oauth/authorize?x=1', asksForCode: true, fields: null });
    const done = flow.parse('Open https://claude.ai/oauth/authorize?x=1\nYour token:\nsk-ant-oat01-abc_DEF-123\n');
    expect(done).toMatchObject({ asksForCode: false, fields: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abc_DEF-123' } });
  });
});
