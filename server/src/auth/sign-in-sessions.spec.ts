import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { IntegrationCardsView, SignInView } from '../contract/connections';
import { ClaudeConnection } from '../integrations/agent-runtime/claude/claude-connection';
import { FakeCliSandbox } from '../testing/fake-cli';
import { startFakeModelApi, type FakeModelApi } from '../testing/fake-model-api';
import { call, start, type Started } from './connection-catalog.spec-helpers';

const TOKEN = 'sk-ant-oat01-good-token-1234';
const LINK = 'https://claude.ai/oauth/authorize?code=true';
const PROMPT = `Open this link:\n${LINK}\nPaste the code here:`;

describe('signing in with a CLI', () => {
  let started: Started;
  let api: FakeModelApi;
  let cli: FakeCliSandbox;
  let logged: string[];

  const base = () => `${started.url}/claude/sign-in`;
  const begin = async (actor: string | null = 'alice') => {
    const response = await call(base(), actor, 'POST');
    return { response, view: (await response.json()) as SignInView };
  };
  const poll = async (id: string, actor: string | null = 'alice') =>
    (await (await call(`${base()}/${id}`, actor)).json()) as SignInView;
  const settled = async (id: string) => {
    let view = await poll(id);
    for (let tries = 0; tries < 500 && (view.state === 'waiting' || view.state === 'code'); tries += 1) {
      view = await poll(id);
    }
    return view;
  };
  const rows = () => started.app.get(DataSource).query<Record<string, unknown>[]>('SELECT * FROM integration_secrets');

  beforeEach(async () => {
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(args.join(' ')));
    }
    api = await startFakeModelApi(TOKEN);
    cli = new FakeCliSandbox();
    started = await start({}, [new ClaudeConnection(api.url)], '', cli);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await started.close();
    await api.close();
  });

  it('shows the link, takes the code, and stores the token only after it passes', async () => {
    const { view } = await begin();
    expect(view).toMatchObject({ state: 'waiting', link: null });
    cli.children[0].say(PROMPT);
    expect(await poll(view.id)).toMatchObject({ state: 'code', link: LINK });
    expect(await rows()).toEqual([]);

    const sent = await call(`${base()}/${view.id}/code`, 'alice', 'POST', { code: 'the-code-9876' });
    expect(await sent.json()).toMatchObject({ state: 'waiting' });
    expect(cli.children[0].written).toEqual(['the-code-9876\n']);

    cli.children[0].say(`\nYour token:\n${TOKEN}\n`);
    cli.children[0].exit(0);
    expect(await settled(view.id)).toMatchObject({ state: 'done', message: null });
    expect(await rows()).toMatchObject([{ connection: 'claude' }]);
    expect(api.seen[0]).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(cli.removed).toContain(cli.children[0].containerName);
    const cards = (await (await call(started.url, 'alice')).json()) as IntegrationCardsView;
    expect(cards.cards[0]).toMatchObject({ status: 'connected' });
  });

  it("stores nothing and shows the provider's message when the token fails its test", async () => {
    const { view } = await begin();
    cli.children[0].say(`${PROMPT}\nsk-ant-oat01-wrong-token-0000\n`);
    cli.children[0].exit(0);
    const end = await settled(view.id);
    expect(end).toMatchObject({ state: 'failed', message: 'The key was rejected by the fake model API' });
    expect(await rows()).toEqual([]);
  });

  it("ends failed with the CLI's own message when it exits with an error", async () => {
    const { view } = await begin();
    cli.children[0].complain('Error: the login was denied');
    cli.children[0].exit(1);
    expect(await settled(view.id)).toMatchObject({ state: 'failed', message: 'Error: the login was denied' });
    expect(await rows()).toEqual([]);
  });

  it('ends failed and removes the container when nobody finishes before the deadline', async () => {
    const { view } = await begin();
    cli.children[0].say(PROMPT);
    started.clock.advance(10 * 60 * 1000);
    expect(await poll(view.id)).toMatchObject({ state: 'failed', message: 'the sign-in timed out' });
    expect(cli.removed).toContain(cli.children[0].containerName);
    expect(cli.children[0].stdinEnded).toBe(true);
    expect(await rows()).toEqual([]);
  });

  it('puts the token and the code in no view, message or log', async () => {
    const { view } = await begin();
    cli.children[0].say(PROMPT);
    await call(`${base()}/${view.id}/code`, 'alice', 'POST', { code: 'the-code-9876' });
    cli.children[0].say(`\n${TOKEN}\n`);
    cli.children[0].exit(2);
    const end = await settled(view.id);
    expect(end.state).toBe('failed');
    for (const text of [JSON.stringify(end), ...logged]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('the-code-9876');
    }
  });

  it("refuses another person's session, and any call without a person", async () => {
    const { view } = await begin();
    expect((await call(`${base()}/${view.id}`, 'bob')).status).toBe(403);
    expect((await call(`${base()}/${view.id}/code`, 'bob', 'POST', { code: 'x' })).status).toBe(403);
    expect((await call(`${base()}/${view.id}`, null)).status).toBe(403);
    expect((await call(base(), null, 'POST')).status).toBe(403);
    expect((await call(`${base()}/unknown`, 'alice')).status).toBe(404);
    expect(await poll(view.id)).toMatchObject({ state: 'waiting' });
  });

  it('refuses an empty code and writes nothing to the CLI', async () => {
    const { view } = await begin();
    const response = await call(`${base()}/${view.id}/code`, 'alice', 'POST', { code: '  ' });
    expect(response.status).toBe(400);
    expect(cli.children[0].written).toEqual([]);
  });

  it('replaces the older session of the same person when a new one starts', async () => {
    const first = (await begin()).view;
    const second = (await begin()).view;
    expect(second.id).not.toBe(first.id);
    expect((await call(`${base()}/${first.id}`, 'alice')).status).toBe(404);
    expect(cli.removed).toContain(cli.children[0].containerName);
    expect(cli.removed).not.toContain(cli.children[1].containerName);
  });

  it('answers 404 for an unknown connection and 400 for one without a sign-in', async () => {
    const response = await call(`${started.url}/unknown/sign-in`, 'alice', 'POST');
    expect(response.status).toBe(404);
    await started.close();
    started = await start({}, [{ ...new ClaudeConnection(api.url), signIn: undefined } as never], '', cli);
    expect((await call(`${started.url}/claude/sign-in`, 'alice', 'POST')).status).toBe(400);
  });

  it('lists the sign-in flow after the key flow', async () => {
    const cards = (await (await call(started.url, 'alice')).json()) as IntegrationCardsView;
    expect(cards.cards[0].flows.map((flow) => flow.kind)).toEqual(['secret', 'cli-code']);
  });

  it('removes the container of a session that is still running when the server stops', async () => {
    await begin();
    await started.app.close();
    expect(cli.removed).toContain(cli.children[0].containerName);
  });
});
