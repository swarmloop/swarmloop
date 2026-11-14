import type { ConnectionCard, IntegrationCardsView } from '../../../contract/connections';
import { DataSource } from 'typeorm';
import { call, start, type Started } from '../../../auth/connection-catalog.spec-helpers';
import { startFakeModelApi, type FakeModelApi } from '../../../testing/fake-model-api';
import { CodexConnection } from './codex-connection';

const GOOD = 'sk-good-key-1234';
const BAD = 'sk-bad-key-9876';

describe('the Codex connection', () => {
  let started: Started;
  let api: FakeModelApi;
  const put = (key: string) => call(`${started.url}/codex`, 'alice', 'PUT', { fields: { CODEX_API_KEY: key } });
  const rows = () => started.app.get(DataSource).query<Record<string, unknown>[]>('SELECT * FROM integration_secrets');

  beforeEach(async () => {
    api = await startFakeModelApi(GOOD);
    started = await start({}, [new CodexConnection(api.url)]);
  });
  afterEach(async () => {
    await started.close();
    await api.close();
  });

  it('stores a key that passes the test under its env name, and sends the header the provider needs', async () => {
    const response = await put(GOOD);
    expect(await response.json()).toMatchObject({ id: 'codex', status: 'connected', last4: '1234' });
    expect(await rows()).toMatchObject([{ connection: 'codex' }]);
    expect(api.seen[0]).toMatchObject({ authorization: `Bearer ${GOOD}` });
    const card = (await (await call(started.url, 'alice')).json()) as IntegrationCardsView;
    expect(card.cards[0].flows[0].fields.map((field) => field.name)).toEqual(['CODEX_API_KEY']);
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
    started = await start({ CODEX_AUTH: 'from-env' }, [new CodexConnection(api.url)]);
    const view = (await (await call(started.url, 'alice')).json()) as { cards: ConnectionCard[] };
    expect(view.cards[0]).toMatchObject({ serverDefault: true });
  });
});
