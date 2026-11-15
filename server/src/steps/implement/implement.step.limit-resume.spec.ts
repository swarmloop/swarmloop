import 'reflect-metadata';

import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { ERROR_CODES } from '../../contract/error-codes';
import { deriveState, writeRunState } from '../../history/run-state';
import { RunRepository } from '../../history/run.repository';
import { RuntimeCooldownRepository } from '../../history/runtime-cooldown.repository';
import type { CooldownKey } from '../../history/runtime-cooldown.repository';
import { CommandService } from '../../pipeline/command.service';
import { PipelineService } from '../../pipeline/pipeline.service';
import { Reconciler } from '../../pipeline/reconciler';
import { boot, featureTree, reply, result, seed, writeEnv } from './implement.step.spec-helpers';

const LIMIT_TEXT = "You've hit your 5-hour limit · resets 9:50pm (UTC)";
const HOUR = 3_600_000;
const FIRST = 'PROJ-410';
const SECOND = 'PROJ-411';
const CODEX: CooldownKey = { runtime: 'codex', credential: 'env' };
const CLAUDE: CooldownKey = { runtime: 'claude', credential: 'env' };

async function world(name: string, agents: string, agent: jest.Mock) {
  const root = await mkdtemp(join(tmpdir(), `swarmloop-implement-limit-resume-${name}-`));
  await writeEnv(root);
  const env = (await readFile(join(root, '.env'), 'utf8')).replace('ANTHROPIC_API_KEY=', 'ANTHROPIC_API_KEY=key');
  await writeFile(join(root, '.env'), `${env}CODEX_API_KEY=key\nAGENTS_IMPLEMENT=${agents}\n`);
  const app = await boot(root, agent);
  for (const key of [FIRST, SECOND]) {
    const repo = `${key.toLowerCase()}-api`;
    featureTree(root, key, repo);
    await seed(app, key, 'approve', `${repo}\n`);
    const runs = app.get(RunRepository);
    const run = (await runs.findRun(key))!;
    writeRunState(run, {
      status: 'waiting',
      currentStep: 'implement',
      reason: { code: ERROR_CODES.RUNTIME_LIMIT, message: 'limited' },
    });
    await runs.saveRun(run);
  }
  // The automatic resume reaches the same code a person's Resume does; the test runs it in place of the queue.
  jest
    .spyOn(app.get(CommandService), 'accept')
    .mockImplementation(
      async (_type, key) => ({ replayed: !(await app.get(PipelineService).runThrough(key)) }) as never,
    );
  return app;
}

type World = Awaited<ReturnType<typeof world>>;

const runtimesOf = (agent: jest.Mock) => agent.mock.calls.map((call) => (call[0] as AgentRunInput).runtime);
const codes = async (app: World) =>
  Promise.all(
    [FIRST, SECOND].map(async (key) => deriveState((await app.get(RunRepository).findRun(key))!).reason?.code),
  );

describe('implement step and a person saying a usage limit is over', () => {
  afterEach(() => jest.restoreAllMocks());

  it('deletes the cooldown row on Resume and launches the step on Codex', async () => {
    const agent = jest.fn(async () => result(reply));
    const app = await world('row', 'codex:m-codex', agent);
    try {
      const cooldowns = app.get(RuntimeCooldownRepository);
      await cooldowns.set(CODEX, Date.now() + 3 * HOUR, true);

      await app.get(PipelineService).runThrough(FIRST);

      expect((await cooldowns.earliest([CODEX])).resumeAt).toBe(0);
      expect(runtimesOf(agent)[0]).toBe('codex');
    } finally {
      await app.close();
    }
  });

  it('lets a second run on the same limit go on after that one Resume', async () => {
    const agent = jest.fn(async () => result(reply));
    const app = await world('second', 'codex:m-codex', agent);
    try {
      await app.get(RuntimeCooldownRepository).set(CODEX, Date.now() + 3 * HOUR, true);
      await app.get(Reconciler).resumeLimited();
      expect(agent).not.toHaveBeenCalled();

      await app.get(PipelineService).runThrough(FIRST);
      agent.mockClear();
      await app.get(Reconciler).resumeLimited();

      expect(runtimesOf(agent)[0]).toBe('codex');
      expect((await app.get(RunRepository).findRun(SECOND))!.status).not.toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it("records the limit again with the provider's reset when it still refuses, and both runs wait", async () => {
    const resetsAt = new Date(Date.now() + 2 * HOUR).toISOString();
    const agent = jest.fn(async () => ({ ...result(LIMIT_TEXT), limit: { window: '5-hour', resetsAt } }));
    const app = await world('refused', 'codex:m-codex', agent);
    try {
      const cooldowns = app.get(RuntimeCooldownRepository);
      await cooldowns.set(CODEX, Date.now() + 3 * HOUR, true);

      await app.get(PipelineService).runThrough(FIRST);
      agent.mockClear();
      await app.get(Reconciler).resumeLimited();

      expect((await cooldowns.earliest([CODEX])).until).toBe(Date.parse(resetsAt));
      expect(agent).not.toHaveBeenCalled();
      expect(await codes(app)).toEqual([ERROR_CODES.RUNTIME_LIMIT, ERROR_CODES.RUNTIME_LIMIT]);
    } finally {
      await app.close();
    }
  });

  it('deletes nothing while another runtime of the role is free', async () => {
    const agent = jest.fn(async () => result(reply));
    const app = await world('free', 'claude:m-claude,codex:m-codex', agent);
    try {
      const cooldowns = app.get(RuntimeCooldownRepository);
      await cooldowns.set(CODEX, Date.now() + 3 * HOUR, true);

      await app.get(PipelineService).runThrough(FIRST);

      expect((await cooldowns.earliest([CLAUDE])).resumeAt).toBe(0);
      expect((await cooldowns.earliest([CODEX])).resumeAt).toBeGreaterThan(Date.now());
    } finally {
      await app.close();
    }
  });
});
