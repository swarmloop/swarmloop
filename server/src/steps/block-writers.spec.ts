import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REASON, STOP_NOTE } from '../contract/run-state';
import { ERROR_CODES } from '../contract/error-codes';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { GitRulesError, SwarmloopError } from '../core/swarmloop-error';
import { StepStopped } from '../agent/step-stopped';
import { ChecksStopped } from '../environment/check-pool';
import { ContainerDropped } from '../sandbox/container-gate';
import type { RunEntity } from '../history/entities';
import { repositoryVisit } from '../history/repository.spec-helpers';
import { closeStopped } from '../pipeline/stop-close';
import { RunGuards } from '../pipeline/run-guards';
import { SpendLimit } from './shared/spend-limit';
import { refusedRoute, StartRefused } from './shared/start-refused';
import type { StepName } from '../contract/steps';
import type { OpenedStep } from './step-run';
import { closeStep } from './step-run';
import { errorEnd } from './step-error-end';
import { checkRepeatedBlock } from './implement/implement-record';
import { blockedEnd } from './pipeline/pipeline-result';
import { flakyBlock } from './pipeline/pipeline-red';
import type { StepResult } from './contract/step-contract';
import type { StepContext } from './base-step';
import { automaticRebase } from './pipeline/pipeline-rebase';
import { RunLifecycle } from '../pipeline/run-lifecycle';
import { RunSettler } from '../pipeline/run-settler';
import { SubtaskEnd } from '../pipeline/subtask-end';
import { RunDriver } from '../pipeline/run-driver';
import { RunSubtaskCommandsService } from '../api/run-subtask-commands.service';
import { RunCommandsService } from '../api/run-commands.service';
import { SUBTASK_WAIT_CODES } from '../contract/error-codes';
import { writeRunState } from '../history/run-state';

function storedCode(run: Pick<RunEntity, 'stateReason'>): string | undefined {
  return (JSON.parse(run.stateReason ?? '{}') as { code?: string }).code;
}

/** Closes a visit the way a step does and returns the code the run stored with its blocked status. */
async function closeBlocked(step: StepName, code: string | undefined): Promise<string | undefined> {
  const run = { id: 1, key: 'K-1', status: 'running', currentStep: step } as RunEntity;
  await closeStep({
    runs: { change: jest.fn(), notify: jest.fn() } as never,
    visits: { finalize: jest.fn().mockResolvedValue(null) } as never,
    flows: { activePhases: jest.fn().mockResolvedValue(['planning', 'implementation', 'review', 'ci']) } as never,
    root: '/tmp',
    clock: {} as never,
    run,
    attemptId: 'attempt-1',
    previousStep: step,
    previousStatus: 'running',
    step,
    outcome: 'blocked',
    visit: repositoryVisit(),
    line: 'blocked',
    exitCode: 1,
    code,
  });
  expect(run.status).toBe('blocked');
  return storedCode(run);
}

async function afterErrorEnd(error: unknown, step: StepName): Promise<string | undefined> {
  const end = errorEnd(error, '10:00', new FakeClock(), { RECONCILE_MS: 1000 });
  expect(end?.outcome).toBe('blocked');
  return closeBlocked(step, end?.code);
}

async function afterRoute(result: StepResult, step: StepName): Promise<string | undefined> {
  expect(result.route.to).toBe('block');
  return closeBlocked(step, result.route.to === 'block' ? result.route.code : undefined);
}

/** A run the way the table of stored states has it, with the code its status was written with. */
function storedRun(status: Parameters<typeof writeRunState>[1]['status'], code: string, step = 'implement'): RunEntity {
  const run = { id: 1, key: 'KEY-1', status: 'running', currentStep: step } as RunEntity;
  writeRunState(run, { status, reason: { code, message: 'stored' } });
  return run;
}

/** Fakes a repository whose release stores the change on the run and records it. */
function releasing(run: RunEntity): {
  findRun: jest.Mock;
  release: jest.Mock;
  change: jest.Mock;
  released: RunEntity;
} {
  const released = run;
  return {
    findRun: jest.fn().mockResolvedValue(run),
    release: jest.fn(
      async (_run: RunEntity, change: { status: 'blocked'; reason?: { code: string; message: string } }) => {
        writeRunState(released, { status: change.status, reason: change.reason });
        return released;
      },
    ),
    change: jest.fn(async (_key: string, apply: (row: RunEntity) => void) => {
      apply(released);
      return released;
    }),
    released,
  };
}

/** Nothing is open on a skipped run: the documents and the plan chat hold no question. */
const noDocuments = { latestDocuments: async () => [] } as never;
const noChat = {
  pendingQuestions: async () => [],
  pendingEscalations: async () => [],
  markTaken: async () => undefined,
} as never;

const OPENED = { startedAt: '10:00' } as OpenedStep;

const WRITERS: [string, () => Promise<string | undefined>, string][] = [
  ['errorEnd for a Stop', () => afterErrorEnd(new StepStopped(), 'implement'), REASON.stopped],
  ['errorEnd for a stop with a message', () => afterErrorEnd(new StepStopped([], 'why'), 'implement'), REASON.stopped],
  [
    'the missing-credential stop at a step',
    () => afterErrorEnd(new StepStopped([], 'no key', null), 'implement'),
    REASON.blocked,
  ],
  [
    'the missing-credential stop at a loop step',
    () => afterErrorEnd(new StepStopped([], 'no key', null), 'checks'),
    REASON.loopLimit,
  ],
  ['errorEnd for ChecksStopped', () => afterErrorEnd(new ChecksStopped(), 'checks'), REASON.stopped],
  ['errorEnd for ContainerDropped', () => afterErrorEnd(new ContainerDropped(), 'implement'), REASON.stopped],
  [
    'errorEnd for GitRulesError',
    () => afterErrorEnd(new GitRulesError('host', 'a push'), 'implement'),
    ERROR_CODES.GIT_RULES,
  ],
  [
    'errorEnd for an image error',
    () =>
      afterErrorEnd(new SwarmloopError('no image', { code: ERROR_CODES.IMAGE_MISSING, category: 'user' }), 'implement'),
    ERROR_CODES.IMAGE_MISSING,
  ],
  [
    'checkRepeatedBlock',
    () => afterRoute(checkRepeatedBlock('10:00', 'checks', new Error('again')), 'checks'),
    REASON.checkFailed,
  ],
  [
    'refusedRoute for a limit',
    () => afterRoute({ route: refusedRoute(StartRefused.limit('over')), summary: 'over', outputs: [] }, 'implement'),
    ERROR_CODES.SPEND_LIMIT,
  ],
  ['flakyBlock', () => afterRoute(flakyBlock(OPENED, 'a test'), 'pipeline'), ERROR_CODES.TEST_FLAKY],
  [
    'blockedEnd for an unreadable log',
    () => afterRoute(blockedEnd('l', REASON.ciLogUnavailable), 'pipeline'),
    REASON.ciLogUnavailable,
  ],
  [
    'blockedEnd for the return limit',
    () => afterRoute(blockedEnd('l', REASON.loopLimit), 'pipeline'),
    REASON.loopLimit,
  ],
  [
    'blockedEnd for CI that did not run',
    () => afterRoute(blockedEnd('l', ERROR_CODES.CI_NOT_RUN), 'pipeline'),
    ERROR_CODES.CI_NOT_RUN,
  ],
  ['blockedEnd for a CI timeout', () => afterRoute(blockedEnd('l', REASON.ciTimeout), 'pipeline'), REASON.ciTimeout],
  ['closeStep with no code at a loop step', () => closeBlocked('pipeline', undefined), REASON.loopLimit],
  ['closeStep with no code at another step', () => closeBlocked('requirements', undefined), REASON.blocked],
  [
    'the automatic rebase that fails',
    async () => {
      const run = storedRun('running', 'x');
      const runs = releasing(run);
      const ctx = { opened: { run }, write: jest.fn() } as unknown as StepContext;
      const failing = { rebase: jest.fn().mockRejectedValue(new Error('conflict')) };
      const after = automaticRebase({ ctx, runs: runs as never, rebase: failing, halted: () => false });
      await after({ exitCode: 0, message: 'ok' });
      expect(run.status).toBe('blocked');
      return storedCode(run);
    },
    ERROR_CODES.REBASE_CONFLICT,
  ],
  [
    'RunSettler for a workspace it cannot bring back',
    async () => {
      const run = storedRun('failed', 'x');
      run.generation = 1;
      const runs = releasing(run);
      const journal = JSON.stringify({ repo: { checkpoint: 'applying', generation: 1, path: '/none' } });
      const disk = new SwarmloopError('disk low', { code: ERROR_CODES.DISK_LOW, category: 'user' });
      const nothing = null as never;
      const settler = new RunSettler(
        runs as never,
        { latestBody: jest.fn().mockResolvedValue(journal) } as never,
        nothing,
        nothing,
        nothing,
        nothing,
        nothing,
        nothing,
        nothing,
        { ensure: jest.fn().mockRejectedValue(disk) } as never,
        nothing,
        nothing,
      );
      await settler.settleRebase(run);
      expect(run.status).toBe('blocked');
      return storedCode(run);
    },
    ERROR_CODES.DISK_LOW,
  ],
  [
    'RunLifecycle.stop of a run that waits for an outage',
    async () => {
      const run = storedRun('waiting', ERROR_CODES.HOST_UNAVAILABLE);
      const runs = releasing(run);
      const nothing = null as never;
      const lifecycle = new RunLifecycle(
        runs as never,
        nothing,
        nothing,
        nothing,
        nothing,
        { halted: () => false } as never,
        nothing,
        nothing,
        nothing,
        nothing,
        nothing,
        nothing,
        nothing,
      );
      await lifecycle.stop('KEY-1');
      expect(run.status).toBe('blocked');
      return storedCode(run);
    },
    REASON.stopped,
  ],
  [
    'RunCommandsService.stop of a parent that waits between passes',
    async () => {
      const run = storedRun('waiting', SUBTASK_WAIT_CODES[0]);
      run.split = true;
      const runs = releasing(run);
      const nothing = null as never;
      const commands = new RunCommandsService(
        runs as never,
        nothing,
        { stop: jest.fn().mockResolvedValue({ exitCode: 0, message: 'stopped' }) } as never,
        nothing,
        nothing,
        nothing,
        nothing,
        nothing,
        nothing,
        { stopAll: jest.fn() } as never,
        nothing,
        nothing,
      );
      await commands.stop('KEY-1');
      expect(run.status).toBe('blocked');
      return storedCode(run);
    },
    REASON.stopped,
  ],
  [
    'RunSubtaskCommandsService.skipTask for a running task',
    async () => {
      const parent = storedRun('waiting', ERROR_CODES.SUBTASKS_RUNNING);
      const child = storedRun('waiting', ERROR_CODES.SUBTASKS_RUNNING);
      const task = {
        id: 'a',
        title: 'a',
        description: '',
        depends: [],
        files: ['a.ts'],
        proof: 'p',
        status: 'running',
      };
      const runs = { ...releasing(child), held: () => false, findSubtask: async () => child };
      const nothing = null as never;
      const subtasks = { stop: jest.fn(), closeMergeRequests: jest.fn(), passDue: () => false };
      const documents = {
        latestBody: async () => `${JSON.stringify([task])}\n`,
        putDocument: jest.fn(),
        latestDocuments: async () => [],
      };
      const commands = new RunSubtaskCommandsService(
        runs as never,
        documents as never,
        nothing,
        nothing,
        subtasks as never,
        nothing,
        noChat,
      );
      await commands.skipTask(parent.key, 'a');
      expect(child.status).toBe('blocked');
      return storedCode(child);
    },
    REASON.skipped,
  ],
  [
    'SubtaskEnd.close',
    async () => {
      const child = storedRun('waiting', ERROR_CODES.SUBTASK_WAITING);
      const logger = { warn: jest.fn() } as never;
      const port = { stop: jest.fn(), closeMergeRequests: jest.fn() };
      const end = new SubtaskEnd(releasing(child) as never, noDocuments, noChat, port, logger);
      await end.close({} as RunEntity, child, 'skipped by its epic: x');
      expect(child.status).toBe('blocked');
      return storedCode(child);
    },
    REASON.skipped,
  ],
  ...(['done', 'checks'] as const).map((step): [string, () => Promise<string | undefined>, string] => [
    `RunDriver.execute of the step ${step} that has no service`,
    async () => {
      const run = storedRun('waiting', 'x', step);
      const nothing = null as never;
      const driver = new RunDriver(
        { ...releasing(run), begin: async () => run } as never,
        nothing,
        { get: () => undefined } as never,
        nothing,
        nothing,
        nothing,
        new FakeClock(),
        { flush: jest.fn() } as never,
        nothing,
        nothing,
        nothing,
      );
      await driver.execute(step, run.key, {});
      expect(run.status).toBe('blocked');
      return storedCode(run);
    },
    step === 'checks' ? REASON.loopLimit : REASON.blocked,
  ]),
  [
    'closeStopped',
    async () => {
      const run = { id: 1, key: 'K-1', status: 'running', currentStep: 'implement' } as RunEntity;
      await closeStopped({ finalize: jest.fn().mockResolvedValue(null) } as never, new FakeClock(), run);
      expect(run.status).toBe('blocked');
      return storedCode(run);
    },
    REASON.stopped,
  ],
  [
    'RunGuards.block',
    async () => {
      const release = jest.fn();
      const guards = new RunGuards(
        null as never,
        null as never,
        new SpendLimit({ release } as never, null as never, null as never, null as never),
        null as never,
        null as never,
      );
      await guards.block({} as RunEntity, 'implement', ERROR_CODES.SPEND_LIMIT, 'over');
      const change = release.mock.calls[0]?.[1] as { status: string; reason: { code: string } };
      expect(change.status).toBe('blocked');
      return change.reason.code;
    },
    ERROR_CODES.SPEND_LIMIT,
  ],
];

const SRC = join(__dirname, '..');
const FORMS = [/status: 'blocked'/, /to: 'block'/, /outcome: 'blocked'/, /blockedEnd\(/, /settle\([^)]*'blocked'/];

/** Product files that write a blocked status, each walked above or already passing its own code. */
const WRITER_FILES = [
  'agent/step-stopped.ts',
  'steps/step-error-end.ts',
  'steps/step-run.ts',
  'steps/implement/implement-improve.step.ts',
  'steps/implement/implement-pipeline-return.ts',
  'steps/implement/implement-record.ts',
  'steps/implement/implement.step.ts',
  'steps/implement/split-pass.ts',
  'steps/pipeline/ci-not-started.ts',
  'steps/pipeline/missing-pipeline.ts',
  'steps/pipeline/pipeline-rebase.ts',
  'steps/pipeline/pipeline-red.ts',
  'steps/pipeline/pipeline-result.ts',
  'steps/pipeline/pipeline.step.ts',
  'steps/requirements/requirements-visit.ts',
  'steps/requirements/requirements.step.ts',
  'steps/run-rebase.ts',
  'steps/shared/spend-limit.ts',
  'steps/shared/start-refused.ts',
  'pipeline/run-driver.ts',
  'pipeline/run-guards.ts',
  'pipeline/run-lifecycle.ts',
  'pipeline/run-settler.ts',
  'pipeline/stop-close.ts',
  'pipeline/skip-run.ts',
  'api/run-commands.service.ts',
  'api/run-subtask-commands.service.ts',
];

const NOT_WRITERS: Record<string, string> = {
  'api/run-rebase.service.ts': "returns { status: 'blocked' } as a response, it stores nothing",
  'core/pipeline-result.ts': 'settle() is the step-end input; the closeStep cases cover it',
  'steps/contract/step-contract.ts': 'declares the block route type',
};

function productFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : productFiles(path);
    return entry.name.endsWith('.ts') && !/\.spec(-helpers)?\.ts$/.test(entry.name) ? [path] : [];
  });
}

describe('every writer of a blocked status', () => {
  it('keeps a Stop note on the StepStopped message', () => {
    expect(new StepStopped().message).toBe(STOP_NOTE);
  });

  it.each(WRITERS)('stores a code: %s', async (_name, write, expected) => {
    await expect(write()).resolves.toBe(expected);
  });

  it('lists every product file that writes a blocked status', () => {
    const known = new Set([...WRITER_FILES, ...Object.keys(NOT_WRITERS)]);
    const unlisted = productFiles(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => {
        const text = readFileSync(join(SRC, path), 'utf8');
        return FORMS.some((form) => form.test(text)) && !known.has(path);
      });
    expect(unlisted).toEqual([]);
  });
});
