import 'reflect-metadata';
import { ERROR_CODES } from '../contract/error-codes';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { createTestApp } from '../testing/test-app';
import type { TestApp } from '../testing/test-app';
import { save } from '../testing/runs.spec-helpers';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { agentFor } from '../config/agents';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { RunEntity } from '../history/entities';
import { sessionFileName, sessionHome } from '../history/session-group';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { Reconciler } from './reconciler';
import { SubtaskPort } from './subtask-port';

const KEY = 'PROJ-500';

/** A split parent that waits for one running subtask, with the fingerprint of its last pass recorded or not. */
async function waitingParent(app: TestApp, recorded: boolean, blocked = false) {
  const runs = app.app.get(RunRepository);
  const parent = await save(runs, KEY, 'implement', 'waiting');
  parent.split = true;
  writeRunState(
    parent,
    blocked
      ? { status: 'blocked', reason: { code: ERROR_CODES.SUBTASK_BLOCKED, message: 'subtask a is blocked' } }
      : { status: 'waiting', reason: { code: ERROR_CODES.SUBTASKS_RUNNING, message: 'running' } },
  );
  await runs.saveRun(parent);
  const child = await save(runs, `${KEY}-a`, 'research', 'running');
  child.parentRunId = parent.id;
  child.taskId = 'a';
  await runs.saveRun(child);
  if (recorded) await runs.recordSubtaskFingerprint(parent, await runs.subtaskFingerprint(parent));
  return { runs, child };
}

describe('reconciler and the subtasks of a parent', () => {
  let app: TestApp;
  let resumed: jest.SpyInstance;

  beforeEach(async () => {
    app = await createTestApp();
    resumed = jest.spyOn(app.app.get(SubtaskPort), 'resumeParent').mockResolvedValue();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  const ticks = async (count: number) => {
    for (let tick = 0; tick < count; tick++) await app.app.get(Reconciler).resumeSubtaskParents();
  };

  it('does not resume a waiting parent whose subtasks did not change', async () => {
    await waitingParent(app, true);

    await ticks(3);

    expect(resumed).not.toHaveBeenCalled();
  });

  it('resumes a parent once when a subtask changed without an event', async () => {
    const { runs, child } = await waitingParent(app, true);
    writeRunState(child, { status: 'done', currentStep: 'done' });
    await runs.saveRun(child);

    await ticks(1);

    expect(resumed).toHaveBeenCalledTimes(1);
  });

  it('resumes a parent with no fingerprint', async () => {
    await waitingParent(app, false);

    await ticks(1);

    expect(resumed).toHaveBeenCalledTimes(1);
  });

  it('wakes a parent blocked with SUBTASK_BLOCKED when a subtask changed, and leaves it when nothing changed', async () => {
    const { runs, child } = await waitingParent(app, true, true);

    await ticks(2);
    expect(resumed).not.toHaveBeenCalled();

    writeRunState(child, { status: 'done', currentStep: 'done' });
    await runs.saveRun(child);
    await ticks(1);

    expect(resumed).toHaveBeenCalledTimes(1);
  });
});

describe('the agents of an epic parent and of its subtasks', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp({
      env: {
        EPIC_EFFORT: 'xhigh',
        AGENTS_PLAN: 'claude:claude-opus-5-5:high',
        AGENTS_SUBTASK_PLAN: 'claude:claude-sonnet-5-5:medium',
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("keeps a subtask's agents at the effort of the subtask tier", async () => {
    const { runs, child } = await waitingParent(app, true);
    const parent = (await runs.findRun(KEY))!;
    parent.epicAt = '2026-11-13T10:00:00.000Z';
    await runs.saveRun(parent);

    const { env } = app.app.get(AppConfig);

    expect(agentFor(env, child, 'plan')).toEqual({ runtime: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
  });

  it("runs the parent's answer to a subtask question at the epic effort", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmloop-reconciler-subtasks-'));
    mkdirSync(join(dir, 'data'), { recursive: true });
    mkdirSync(agentStateDir(dir, KEY, sessionHome('plan')), { recursive: true });
    writeFileSync(
      join(dir, 'data', sessionFileName(KEY, 'plan')),
      JSON.stringify({ runtime: 'claude', chatId: 'chat-1', usd: 0 }),
    );
    const parent = { key: KEY, targetPath: dir, agentCalls: 0, spentUsd: 0, epicAt: '2026-11-13T10:00:00.000Z' };
    const launch = jest.fn().mockResolvedValue({
      responseText: 'use the shared helper',
      chatId: 'chat-1',
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      killReason: null,
      exitCode: 0,
      resumed: true,
      calls: 1,
      samples: [],
      durationMs: 0,
      startedAt: '',
      finishedAt: '',
    });
    const env = testEnv({
      SWARMLOOP_ROOT: dir,
      EPIC_EFFORT: 'xhigh',
      AGENTS_PLAN: 'claude:claude-opus-5-5:high',
      AGENTS_SUBTASK_PLAN: 'claude:claude-sonnet-5-5:medium',
    });
    const port = new SubtaskPort(
      {} as never,
      { latestBody: async () => 'app\n' } as never,
      { submit: async () => undefined } as never,
      { launch } as never,
      { finishVisit: async () => undefined } as never,
      new AppConfig(env),
      new FakeClock(),
    );

    await port.answer(
      { run: parent, startedAt: '2026-11-13T10:00:00.000Z' } as never,
      { key: `${KEY}-a` } as RunEntity,
      { id: 'a' } as never,
      'contract',
    );

    expect(launch.mock.calls[0][0]).toMatchObject({ effort: 'xhigh', effortNote: 'epic' });
  });
});
