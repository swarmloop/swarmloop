import 'reflect-metadata';
import { mkdir, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { INestApplicationContext } from '@nestjs/common';
import { RunStop } from '../agent/run-stop';
import type { AgentRunInput, AgentRunResult } from '../agent/agent-runner';
import { ChatService } from '../api/chat.service';
import { RunListRows } from '../api/run-list-rows';
import { RunQueriesService } from '../api/run-queries.service';
import { StatsController } from '../api/stats.controller';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { etaPhase } from '../contract/eta';
import { runTaskStatus } from '../contract/subtask';
import { ERROR_CODES } from '../contract/error-codes';
import { NEEDS_PERSON, REASON, type RunState } from '../contract/run-state';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { StatsRepository } from '../history/stats.repository';
import { recoveringSince, storedState, writeRunState, type RunStateChange } from '../history/run-state';
import { stopReason } from '../pipeline/backlog/planner/planner-run-state';
import { backlogHarness } from '../pipeline/backlog/backlog.spec-helpers';
import { MergeWatch } from '../pipeline/merge-watch';
import { RunRetention } from '../pipeline/run-retention';
import { EventRepository } from '../history/event.repository';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { WRITE_REFUSAL } from '../steps/shared/start-refused';
import { doorAround } from './agent-door.spec-helpers';
import { RunStateRefresh } from '../steps/shared/run-state-refresh';
import { seededBoot } from '../api/runs-boot.spec-helpers';

/** What each reader of a run's state says about one run. */
interface Readings {
  column: { state: RunState; code: string | undefined };
  flow: { state: RunState; code: string | undefined; actions: string[] };
  list: { state: RunState; code: string | undefined };
  planner: string;
  recovering: boolean;
  /** The status a task shows for this run's state, and whether the phase of its estimate is a person. */
  task: string;
  phase: string;
  /** Merged and closed runs the stats count, and whether retention frees the run's workspace at once. */
  stats: { merged: number; closed: number };
  freed: boolean;
}

interface Setup {
  change: RunStateChange;
  /** A document the facts read: its kind and body. */
  document?: [string, string];
  attemptsReview?: number;
}

let app: INestApplicationContext;
let counter = 0;

beforeEach(async () => {
  app = await seededBoot(await mkdtemp(join(tmpdir(), 'swarmloop-agreement-')));
});

afterEach(async () => {
  await app.close();
});

/** Writes the run the way a step does, lets the state refresh settle, and reads it through every reader. */
async function readings(setup: Setup): Promise<Readings> {
  const key = `proj-agree-${(counter += 1)}`;
  const runs = app.get(RunRepository);
  const run = await runs.begin(key, setup.change.currentStep ?? 'implement');
  writeRunState(run, setup.change);
  run.attemptsReview = setup.attemptsReview ?? 0;
  await runs.saveRun(run);
  if (setup.document) await app.get(DocumentRepository).putDocument(run, ...setup.document);
  runs.notify(key);
  await app.get(RunStateRefresh).settled();
  const stored = (await runs.findRun(key))!;
  const flow = await app.get(RunQueriesService).flow(key);
  const { view } = await app.get(RunListRows).read();
  const row = view.runs.find((item) => item.key === key)!;
  const column = storedState(stored);
  const stats = await new StatsController(
    app.get(StatsRepository),
    runs,
    app.get(DocumentRepository),
    app.get(Clock),
  ).report('0');
  const retention = new RunRetention(runs, {} as never, app.get(AppConfig), app.get(Clock));
  return {
    column: { state: column.state, code: column.reason?.code },
    flow: { state: flow.state, code: flow.stateReason?.code, actions: flow.actions },
    list: { state: row.state, code: row.stateReason?.code },
    planner: await stopReason(runs, key),
    recovering: recoveringSince(stored) !== null,
    task: runTaskStatus({ state: column.state, currentStep: stored.currentStep }),
    phase: etaPhase(column.state, column.reason),
    stats: { merged: stats.totals.merged, closed: stats.totals.closed },
    freed: (await retention.apply(0)).includes(key),
  };
}

/** Every reader gives the state and the reason code of the column. */
function expectAgreement(read: Readings, state: RunState, code?: string): void {
  expect(read.column).toEqual({ state, code });
  expect(read.flow).toMatchObject({ state, code });
  expect(read.list).toEqual({ state, code });
  expect(read.planner).toBe(code ?? '');
  const ended = state === 'merged' || state === 'closed';
  expect(read.stats).toEqual({ merged: state === 'merged' ? 1 : 0, closed: state === 'closed' ? 1 : 0 });
  expect(read.freed).toBe(ended);
}

describe('every reader of a run state agrees with the stored state', () => {
  it('shows open questions as waiting for a person', async () => {
    const read = await readings({
      change: { status: 'waiting', currentStep: 'research' },
      document: ['questions', '- Which field?\n'],
    });
    expectAgreement(read, 'waiting', 'NEEDS_ANSWERS');
    expect(read.flow.actions).toContain('answer');
    expect(read.phase).toBe('person');
    expect(read.task).toBe('running');
  });

  it('shows a run sent back to implement as idle and returned', async () => {
    const read = await readings({ change: { status: 'waiting', currentStep: 'implement' }, attemptsReview: 1 });
    expectAgreement(read, 'idle', REASON.returned);
  });

  it.each(Object.keys(NEEDS_PERSON).filter((code) => code !== 'NEEDS_ANSWERS'))(
    'shows a run blocked on %s as blocked for a person, whichever reader asks',
    async (code) => {
      const read = await readings({
        change: { status: 'blocked', currentStep: 'implement', reason: { code, message: code } },
      });
      expect(read.flow.state).toBe(read.column.state);
      expect(read.list).toEqual(read.column);
      expect(read.flow.code).toBe(read.column.code);
      expect(read.planner).toBe(read.column.code);
      expect(read.column).toEqual({ state: code === REASON.stopped ? 'stopped' : 'blocked', code });
      expect(read.phase).toBe('person');
      expect(read.task).toBe('blocked');
    },
  );

  it('shows a blocked run with no stored code as blocked', async () => {
    expectAgreement(
      await readings({ change: { status: 'blocked', currentStep: 'prepare' } }),
      'blocked',
      REASON.blocked,
    );
  });

  it('keeps the code a blocked run stored when its error says another', async () => {
    const read = await readings({
      change: {
        status: 'blocked',
        currentStep: 'implement',
        reason: { code: ERROR_CODES.SPEND_LIMIT, message: 'spend limit' },
      },
      document: ['error', 'code-review does not fit\n'],
    });
    expectAgreement(read, 'blocked', ERROR_CODES.SPEND_LIMIT);
  });

  it('shows a run whose merge request merged as merged', async () => {
    const read = await readings({
      change: {
        status: 'done',
        currentStep: 'done',
        merge: { merged: { demo: { sha: 'abc', by: null, at: 'x', url: null } } },
      },
    });
    expectAgreement(read, 'merged');
    expect(read.task).toBe('merged');
  });

  it('shows a run that waits for the container of a dead owner as recovering', async () => {
    const since = '2026-01-01T00:00:00.000Z';
    const read = await readings({
      change: {
        status: 'running',
        currentStep: 'implement',
        reason: { code: REASON.recovering, message: since },
        facts: { recovering: true },
      },
    });
    // The run page and the list show a recovering run as running; the column and its readers say recovering.
    expect(read.column).toEqual({ state: 'recovering', code: REASON.recovering });
    expect(read.flow).toMatchObject({ state: 'running', actions: ['stop', 'replay'] });
    expect(read.list.state).toBe('running');
    expect(read.recovering).toBe(true);
  });

  it('tells the merge watch the state the column holds when a stopped run ends on the host', async () => {
    const runs = app.get(RunRepository);
    const run = await runs.begin('proj-agree-watch', 'plan');
    writeRunState(run, {
      status: 'blocked',
      currentStep: 'plan',
      reason: { code: REASON.stopped, message: 'Stopped by request.' },
    });
    run.codeHost = 'github';
    await runs.saveRun(run);
    const request = {
      project: 'acme/demo',
      iid: 1,
      url: 'https://github.com/acme/demo/pull/1',
      draft: false,
      summary: '',
    };
    await app.get(DocumentRepository).putDocument(run, 'merge_request', renderMergeRequest([request]));
    await app.get(RunStateRefresh).settled();
    expect(storedState((await runs.findRun(run.key))!).state).toBe('stopped');
    const lookup = {
      state: async () => ({ state: 'merged', sha: 'abc', by: null, at: '2026-05-01T10:00:00Z', httpCalls: [] }),
      label: () => 'GitHub',
    };
    const events = app.get(EventRepository);
    await new MergeWatch(runs, app.get(DocumentRepository), events, lookup as never, app.get(Clock)).run();
    const [line] = await events.listLoops(run.id);
    expect(line.reason).toBe('The merge request was merged on GitHub while the run was stopped; the run is done.');
    expect(storedState((await runs.findRun(run.key))!).state).toBe('merged');
  });

  it('keeps a run stopped at plan stopped, with Resume, after a chat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-agreement-chat-'));
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    const before = await readings({
      change: {
        status: 'blocked',
        currentStep: 'plan',
        reason: { code: REASON.stopped, message: 'Stopped by request.' },
      },
    });
    expectAgreement(before, 'stopped', REASON.stopped);
    const key = `proj-agree-${counter}`;
    const chat = new ChatService(
      app.get(RunRepository),
      app.get(DocumentRepository),
      app.get(AppConfig),
      app.get(Clock),
      { assertReady: async () => undefined } as never,
      doorAround(
        app,
        new AgentLauncher(
          { run: async (input: AgentRunInput) => answer(input.prompt) } as never,
          { tokenTotal: async () => 1 } as never,
          new RunStop(),
        ),
      ),
      { block: async () => '' } as never,
      { ensureForRequest: async () => undefined } as never,
    );
    await expect(chat.speak(key, { prompt: 'look at it', cwd: project })).rejects.toThrow(WRITE_REFUSAL);
    await app.get(RunStateRefresh).settled();
    const stored = (await app.get(RunRepository).findRun(key))!;
    const flow = await app.get(RunQueriesService).flow(key);
    const { view } = await app.get(RunListRows).read();
    expect(storedState(stored)).toMatchObject({ state: 'stopped', reason: { code: REASON.stopped } });
    expect(flow).toMatchObject({ state: 'stopped', actions: expect.arrayContaining(['resume']) });
    expect(view.runs.find((row) => row.key === key)).toMatchObject({ state: 'stopped' });
    expect(await stopReason(app.get(RunRepository), key)).toBe(REASON.stopped);
  });
});

function answer(prompt: string): AgentRunResult {
  const now = new Date().toISOString();
  return {
    responseText: 'answered',
    chatId: null,
    tokensIn: 2,
    tokensOut: 1,
    usd: 0.01,
    killReason: null,
    exitCode: 0,
    output: prompt,
    resumed: false,
    calls: 1,
    samples: [],
    durationMs: 5,
    startedAt: now,
    finishedAt: now,
  };
}

describe('the backlog observer agrees with the stored state', () => {
  const cases: [string, RunStateChange][] = [
    [
      'a waiting run',
      { status: 'waiting', reason: { code: ERROR_CODES.GIT_AUTH, message: 'the git login was refused' } },
    ],
    [
      'a blocked run',
      { status: 'blocked', reason: { code: ERROR_CODES.GIT_RULES, message: 'the branch was refused' } },
    ],
    ['a stopped run', { status: 'blocked', reason: { code: REASON.stopped, message: 'Stopped by request.' } }],
  ];

  it.each(cases)('writes run-needs-person with the state and reason of the column for %s', async (_name, change) => {
    const h = await backlogHarness();
    try {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', []);
      await h.moveRun('a-1', change);
      await h.tick();
      await h.tick();
      const run = (await h.db.app.get(RunRepository).findRun('a-1'))!;
      const events = (await h.backlogs.events(id, 100)).filter((event) => event.kind === 'run-needs-person');
      expect(events).toHaveLength(1);
      expect(events[0].facts).toMatchObject({
        state: storedState(run).state,
        reason: storedState(run).reason?.message,
      });
    } finally {
      await h.scheduler().onModuleDestroy();
      await h.db.close();
    }
  });
});
