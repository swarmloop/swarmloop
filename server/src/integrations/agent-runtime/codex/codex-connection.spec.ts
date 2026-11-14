import type { ConnectionCard, IntegrationCardsView } from '../../../contract/connections';
import { DataSource } from 'typeorm';
import { call, start, type Started } from '../../../auth/connection-catalog.spec-helpers';
import { FakeCliSandbox } from '../../../testing/fake-cli';
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

describe('the Codex ChatGPT sign-in', () => {
  const AUTH = Buffer.from('{"tokens":{"id":"x"}}').toString('base64');
  const DEVICE_OUTPUT = `Open https://auth.openai.com/codex/device\nand enter the code ABCD-12345\n\nAUTH_JSON_B64:${AUTH}`;
  const flow = new CodexConnection().signIn();

  it('runs the device login and prints auth.json in the same container', () => {
    const [shell, flag, script] = flow.command();
    expect([shell, flag]).toEqual(['sh', '-c']);
    expect(script).toBe(
      'codex login --device-auth && printf "\\nAUTH_JSON_B64:" && base64 -w0 /home/sandbox/.codex/auth.json',
    );
  });

  it('shows the link and the code while it waits, and gives the login after it', () => {
    const waiting = flow.parse('Open https://auth.openai.com/codex/device\nand enter the code ABCD-12345\n');
    expect(waiting).toEqual({
      link: 'https://auth.openai.com/codex/device',
      code: 'ABCD-12345',
      asksForCode: false,
      fields: null,
    });
    expect(flow.parse(DEVICE_OUTPUT)).toMatchObject({ code: 'ABCD-12345', fields: { CODEX_AUTH: AUTH } });
  });

  describe('the account check', () => {
    let started: Started;
    let cli: FakeCliSandbox;
    const put = () => call(`${started.url}/codex`, 'alice', 'PUT', { fields: { CODEX_AUTH: AUTH } });
    const rows = () =>
      started.app.get(DataSource).query<Record<string, unknown>[]>('SELECT * FROM integration_secrets');

    beforeEach(async () => {
      cli = new FakeCliSandbox();
      started = await start({}, [new CodexConnection()], '', cli);
    });
    afterEach(() => started.close());

    it('stores the login when `codex login status` passes, and runs it with the login in place', async () => {
      cli.script = (child) => {
        child.say('Logged in using ChatGPT\n');
        child.exit(0);
      };
      const response = await put();
      expect(await response.json()).toMatchObject({ status: 'connected', account: 'Logged in using ChatGPT' });
      expect(cli.launches[0]).toMatchObject({
        runtime: 'codex',
        command: ['codex', 'login', 'status'],
        env: [{ name: 'CODEX_AUTH', value: AUTH }],
      });
      expect(await rows()).toMatchObject([{ connection: 'codex' }]);
    });

    it("answers with the CLI's message when the check fails and stores nothing", async () => {
      cli.script = (child) => {
        child.complain('Not logged in\n');
        child.exit(1);
      };
      const response = await put();
      expect(response.status).toBe(400);
      expect(((await response.json()) as { message: string }).message).toBe('Not logged in');
      expect(await rows()).toEqual([]);
    });
  });
});
