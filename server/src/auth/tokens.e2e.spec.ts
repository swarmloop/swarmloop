import 'reflect-metadata';
import { fakeConnection } from '../testing/fake-connection';
import { PersonalCredentials } from './personal-credentials.service';
import { PersonalTokens } from './personal-tokens.service';
import { FAKE_MODEL_KEY } from '../testing/env.spec-helpers';
import { UserSettingRepository } from '../history/user-setting.repository';
import { DocumentRepository } from '../history/document.repository';
import { writeRunState } from '../history/run-state';
import { RunRepository } from '../history/run.repository';
import { CommandService } from '../pipeline/command.service';
import { createTestApp, type TestApp } from '../testing/test-app';
import { child, KEY, pass, requirements, settle, task, world } from '../steps/implement/split-implement.spec-helpers';
import type { CreatedTokenView, CurrentTokenView, TokensView } from '../contract/people';

const OWN_KEY = 'sk-ant-own-4d1e8f7a2b9c';
const DAY = 24 * 3600 * 1000;
const JSON_HEADERS = { 'content-type': 'application/json' };

describe('personal tokens', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp({ env: FAKE_MODEL_KEY });
  });

  afterEach(async () => {
    await app.app.get(CommandService).idle();
    await app.close();
  });

  const send = (path: string, headers: object, method = 'GET', body?: object) =>
    fetch(`${app.url}${path}`, {
      method,
      headers: { ...JSON_HEADERS, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });

  async function made(login: string, expiresInDays: 30 | 90 | null = null) {
    const session = await app.sessionCookie(login);
    const response = await send('/tokens', session, 'POST', { name: 'laptop', expiresInDays });
    expect(response.status).toBe(201);
    const created = (await response.json()) as CreatedTokenView;
    return { session, created, bearer: { authorization: `Bearer ${created.value}` } };
  }

  it('acts as its person: a run it starts stores that person and their agent list', async () => {
    const { bearer } = await made('ann');
    const agents = { main: { plan: [{ runtime: 'claude', model: 'ann-plan' }] } };
    await app.app.get(UserSettingRepository).save('ann', { agents });
    const claude = fakeConnection({ id: 'claude', fields: ['ANTHROPIC_API_KEY'], envName: 'ANTHROPIC_API_KEY' });
    await app.app.get(PersonalCredentials).store(claude, 'ann', { ANTHROPIC_API_KEY: OWN_KEY }, null);

    const started = await send('/runs', bearer, 'POST', { key: 'PROJ-501', prompt: 'Ship it', projects: ['demo'] });
    expect(started.status).toBe(202);

    const run = await app.app.get(RunRepository).findRun('PROJ-501');
    expect(run?.startedBy).toBe('ann');
    expect(run?.agents).toEqual(agents);
    const credentials = app.app.get(PersonalCredentials);
    expect(await credentials.credentialKey('claude', run?.startedBy ?? null)).toBe('ann');
    expect((await credentials.runtimeCredential('claude', run?.startedBy ?? null))?.value).toBe(OWN_KEY);
  });

  it('is refused when it tries to make a token', async () => {
    const { bearer } = await made('ann');
    for (const [path, body] of [
      ['/tokens', { name: 'more', expiresInDays: null }],
      ['/tokens/existing', { name: 'more', expiresInDays: null, value: 'x'.repeat(40) }],
    ] as const) {
      const response = await send(path, bearer, 'POST', body);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('a token cannot make a token');
    }
  });

  it('stores a pasted token value under the session person', async () => {
    const session = await app.sessionCookie('ann');
    const value = 'p'.repeat(40);
    const response = await send('/tokens/existing', session, 'POST', { name: 'pasted', expiresInDays: 90, value });
    expect(response.status).toBe(201);
    expect((await send('/tokens/current', { authorization: `Bearer ${value}` })).status).toBe(200);
  });

  it('refuses a revoked token and an expired one', async () => {
    const forever = await made('ann');
    const short = await made('ann', 30);
    expect((await send('/tokens/current', short.bearer)).status).toBe(200);
    app.clock.advance(31 * DAY);
    expect((await send('/tokens/current', short.bearer)).status).toBe(401);
    expect((await send('/tokens/current', forever.bearer, 'DELETE')).status).toBe(204);
    expect((await send('/tokens/current', forever.bearer)).status).toBe(401);
  });

  it('names its person on /tokens/current and revokes itself, and answers 400 to a session', async () => {
    const { session, bearer } = await made('ann');
    expect((await send('/tokens/current', bearer).then((r) => r.json())) as CurrentTokenView).toMatchObject({
      login: 'ann',
      name: 'laptop',
    });
    for (const method of ['GET', 'DELETE']) {
      const response = await send('/tokens/current', session, method);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('only a token can do this');
    }
  });

  it('lists name, created, last used and expiry, and never a value', async () => {
    const { session, bearer, created } = await made('ann', 90);
    await send('/tokens/current', bearer);
    const text = await send('/tokens', session).then((r) => r.text());
    expect(text).not.toContain(created.value);
    const [listed] = (JSON.parse(text) as TokensView).tokens;
    expect(listed).toEqual({
      id: created.id,
      name: 'laptop',
      createdAt: app.clock.iso(),
      lastUsedAt: app.clock.iso(),
      expiresAt: new Date(app.clock.now() + 90 * DAY).toISOString(),
    });
  });

  it('shows and revokes only the tokens of their own person', async () => {
    const ann = await made('ann');
    const bob = await made('bob');
    expect(((await send('/tokens', bob.session).then((r) => r.json())) as TokensView).tokens).toHaveLength(1);
    await send(`/tokens/${ann.created.id}`, bob.session, 'DELETE');
    expect(await app.app.get(PersonalTokens).personOf(ann.created.value)).toBe('ann');
    expect((await send(`/tokens/${ann.created.id}`, ann.session, 'DELETE')).status).toBe(204);
    expect(await app.app.get(PersonalTokens).personOf(ann.created.value)).toBeNull();
  });
});

describe('a run started through a token', () => {
  it('gives its subtasks the same person', async () => {
    const { app } = await world(FAKE_MODEL_KEY);
    try {
      const session = await app.sessionCookie('ann');
      const created = (await fetch(`${app.url}/tokens`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, ...session },
        body: JSON.stringify({ name: 'laptop', expiresInDays: null }),
      }).then((r) => r.json())) as CreatedTokenView;
      const started = await fetch(`${app.url}/runs`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, authorization: `Bearer ${created.value}` },
        body: JSON.stringify({ key: KEY, prompt: 'Ship it', projects: ['demo'] }),
      });
      expect(started.status).toBe(202);
      await settle(app);

      const runs = app.app.get(RunRepository);
      const parent = (await runs.findRun(KEY))!;
      expect(parent.startedBy).toBe('ann');
      writeRunState(parent, { status: 'waiting', currentStep: 'implement' });
      parent.split = true;
      parent.projects = 'demo\n';
      await runs.saveRun(parent);
      const documents = app.app.get(DocumentRepository);
      await documents.putDocument(parent, 'requirements', requirements);
      await documents.putDocument(parent, 'subtasks', `${JSON.stringify([task('a')])}\n`);
      await pass(app);
      await settle(app);
      expect((await child(app, 'a')).startedBy).toBe('ann');
    } finally {
      await app.close();
    }
  });
});
