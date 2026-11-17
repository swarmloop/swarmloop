import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { StoredAgents } from '../contract/api';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { CommandService } from '../pipeline/command.service';
import { RunRepository } from '../history/run.repository';
import { UserSettingRepository } from '../history/user-setting.repository';
import { createTestApp, type TestApp } from '../testing/test-app';

const KEY = 'PROJ-59';
const AGENTS: StoredAgents = {
  main: {
    plan: ['claude'],
    implement: ['codex'],
    review: ['claude'],
  },
  subtask: { plan: ['claude'], implement: ['codex'], review: ['claude'] },
} as unknown as StoredAgents;

describe('a person takes over a run recorded as machine', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp();
    await app.app.get(UserSettingRepository).save('ann', { agents: AGENTS });
  });

  afterEach(async () => {
    await app.close();
  });

  const seed = async (key: string, startedBy: string | null, parentId?: number) => {
    const runs = app.app.get(RunRepository);
    const run =
      parentId === undefined
        ? runs.newWaitingRun(key, null, startedBy, null)
        : await runs.openSubtask(key, parentId, 'a', startedBy, null);
    run.currentStep = 'research';
    run.status = 'failed';
    return runs.saveRun(run);
  };

  const columns = async (key: string) =>
    (
      await app.app
        .get(DataSource)
        .query<{ started_by: string | null; agents: string | null; owner_since: string | null }[]>(
          'SELECT started_by, agents, owner_since FROM runs WHERE key = ?',
          [key],
        )
    )[0];

  const flow = async (key: string) =>
    (await fetch(`${app.url}/runs/${key}`, { headers: app.auth })).json() as Promise<{
      startedBy?: string;
      ownerSince?: string;
    }>;

  /** The command is accepted in a transaction before its handler runs, so the takeover is stored whatever the handler answers. */
  const post = async (path: string, who: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${app.url}${path}`, {
      method: 'POST',
      headers: { ...(await app.personToken(who)), 'content-type': 'application/json', ...headers },
      body: '{}',
    });
    await app.app.get(CommandService).idle();
    return response;
  };

  it('keeps the env tokens for a machine run nobody took over', async () => {
    await seed(KEY, 'machine');
    const registry = app.app.get(CodeHostRegistry);
    expect(await registry.forRun('machine', 'gitlab')).toBe(registry);
    expect(await columns(KEY)).toMatchObject({ started_by: 'machine', owner_since: null });
  });

  it.each([
    ['Resume', `/runs/${KEY}/resume`],
    ['Replay', `/runs/${KEY}/steps/research/replay`],
    ['Rebase', `/runs/${KEY}/rebase`],
  ])(
    'makes the person of a %s the owner, with their agent lists, and moves the machine subtasks',
    async (_name, path) => {
      const parent = await seed(KEY, 'machine');
      await seed(`${KEY}-a`, 'machine', parent.id);
      await seed(`${KEY}-b`, 'bob', parent.id);
      app.clock.advance(1000);

      await post(path, 'ann');

      const taken = await columns(KEY);
      expect(taken).toMatchObject({ started_by: 'ann', owner_since: app.clock.iso() });
      expect(JSON.parse(taken.agents ?? 'null')).toEqual(AGENTS);
      expect(await columns(`${KEY}-a`)).toMatchObject({ started_by: 'ann', owner_since: app.clock.iso() });
      expect(await columns(`${KEY}-b`)).toMatchObject({ started_by: 'bob', owner_since: null });
      expect(await flow(KEY)).toMatchObject({ startedBy: 'ann', ownerSince: app.clock.iso() });
    },
  );

  it('stores no agent lists for a person who has none', async () => {
    await seed(KEY, 'machine');
    await post(`/runs/${KEY}/resume`, 'cy');
    expect(await columns(KEY)).toMatchObject({ started_by: 'cy', agents: null });
  });

  it('leaves a run that a person started alone when another person resumes it', async () => {
    await seed(KEY, 'bob');
    await post(`/runs/${KEY}/resume`, 'ann');
    expect(await columns(KEY)).toMatchObject({ started_by: 'bob', owner_since: null });
    expect((await flow(KEY)).ownerSince).toBeUndefined();
  });

  it('does not take a run over for a Stop', async () => {
    await seed(KEY, 'machine');
    await post(`/runs/${KEY}/stop`, 'ann');
    expect(await columns(KEY)).toMatchObject({ started_by: 'machine', owner_since: null });
  });

  it('does not take a run over again when the same command is sent twice', async () => {
    await seed(KEY, 'machine');
    await post(`/runs/${KEY}/resume`, 'ann', { 'idempotency-key': 'same' });
    const first = await columns(KEY);
    app.clock.advance(5000);
    await post(`/runs/${KEY}/resume`, 'bob', { 'idempotency-key': 'same' });
    expect(await columns(KEY)).toEqual(first);
  });
});
