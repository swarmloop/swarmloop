import 'reflect-metadata';
import { MAX_PENDING_LOGINS } from './cli-logins';
import { PersonalTokens } from './personal-tokens.service';
import type { CliLoginPoll, CliLoginStarted, CliLoginView } from '../contract/people';
import { createTestApp, type TestApp } from '../testing/test-app';

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('the CLI login code flow', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(() => app.close());

  const send = (path: string, headers: object = {}, method = 'GET', body?: object) =>
    fetch(`${app.url}${path}`, {
      method,
      headers: { ...JSON_HEADERS, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  const start = async (machine = 'build-box') =>
    (await send('/auth/cli/logins', {}, 'POST', { machine }).then((r) => r.json())) as CliLoginStarted;
  const poll = async (id: string) => (await send(`/auth/cli/logins/${id}`).then((r) => r.json())) as CliLoginPoll;

  it('answers waiting and holds no token until a signed-in person approves, then hands the token out once', async () => {
    const started = await start();
    expect(started.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.url).toContain(`/cli-login?code=${started.code}`);
    expect(await poll(started.id)).toEqual({ status: 'waiting' });
    expect(await app.app.get(PersonalTokens).list('ann')).toEqual([]);

    const session = await app.sessionCookie('ann');
    expect((await send(`/tokens/cli/${started.code}/approve`, session, 'POST')).status).toBe(204);

    const approved = await poll(started.id);
    expect(approved.status).toBe('approved');
    const { token } = approved as { token: string };
    expect(await app.app.get(PersonalTokens).personOf(token)).toBe('ann');
    expect((await app.app.get(PersonalTokens).list('ann'))[0].name).toBe('CLI on build-box');
    expect(await poll(started.id)).toEqual({ status: 'expired' });
  });

  it('answers expired once the code has run out, and the code is then unknown', async () => {
    const started = await start();
    app.clock.advance(11 * 60 * 1000);
    expect(await poll(started.id)).toEqual({ status: 'expired' });
    const session = await app.sessionCookie('ann');
    expect((await send(`/tokens/cli/${started.code}`, session)).status).toBe(404);
    expect((await send(`/tokens/cli/${started.code}/approve`, session, 'POST')).status).toBe(404);
  });

  it('refuses to approve with a bearer token', async () => {
    const started = await start();
    const bearer = await app.personToken('ann');
    expect((await send(`/tokens/cli/${started.code}/approve`, bearer, 'POST')).status).toBe(403);
    expect(await poll(started.id)).toEqual({ status: 'waiting' });
  });

  it('shows the machine trimmed and cut to 64 characters with an ellipsis', async () => {
    const long = await start(`  ${'m'.repeat(70)}  `);
    const session = await app.sessionCookie('ann');
    const view = (await send(`/tokens/cli/${long.code}`, session).then((r) => r.json())) as CliLoginView;
    expect(view.machine).toBe(`${'m'.repeat(64)}…`);
    const short = await start('  laptop ');
    expect(((await send(`/tokens/cli/${short.code}`, session).then((r) => r.json())) as CliLoginView).machine).toBe(
      'laptop',
    );
  });

  it('answers 401 to the approval page without a person', async () => {
    const started = await start();
    expect((await send(`/tokens/cli/${started.code}`)).status).toBe(401);
  });

  it('keeps at most the cap of pending logins: the oldest is dropped and the newest code still works', async () => {
    const first = await start();
    for (let i = 0; i < MAX_PENDING_LOGINS; i++) await start();
    expect(await poll(first.id)).toEqual({ status: 'expired' });
    const newest = await start();
    expect(await poll(newest.id)).toEqual({ status: 'waiting' });
    const session = await app.sessionCookie('ann');
    expect((await send(`/tokens/cli/${newest.code}`, session)).status).toBe(200);
  });
});
