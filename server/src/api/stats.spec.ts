import { BadRequestException } from '@nestjs/common';
import type { StatsRows, StatsStepRow } from '../history/stats.repository';
import { buildStats, localDay, outcomeOf, rangeStart } from './stats';
import { StatsController } from './stats.controller';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const WARSAW = -60;
const NO_PERSON: StatsRows['person'] = { answers: [], planChats: [], backlogMessages: [] };

function step(runId: number, name: string, usd: number, finishedAt: string, extra: Partial<StatsStepRow> = {}) {
  return {
    runId,
    step: name,
    runtime: null,
    model: usd > 0 ? 'model-a' : null,
    effort: null,
    status: 'done',
    killReason: null,
    usd,
    tokensIn: usd > 0 ? 1000 : 0,
    tokensOut: usd > 0 ? 100 : 0,
    durationMs: 60_000,
    finishedAt,
    shellEdits: 0,
    ...extra,
  };
}

function rows(): StatsRows {
  return {
    firstRunAt: '2026-11-01T10:00:00.000Z',
    runs: [
      {
        id: 1,
        key: 'run-a',
        prompt: 'Add a stats page\nmore text',
        status: 'done',
        runtime: 'claude',
        createdAt: '2026-11-08T10:00:00.000Z',
      },
      { id: 2, key: 'run-b', prompt: null, status: 'blocked', runtime: 'codex', createdAt: '2026-11-09T23:30:00.000Z' },
      {
        id: 3,
        key: 'run-c',
        prompt: 'Fix the bug',
        status: 'waiting',
        runtime: 'claude',
        createdAt: '2026-11-10T08:00:00.000Z',
      },
      {
        id: 4,
        key: 'run-d',
        prompt: 'One pass',
        status: 'done',
        runtime: 'cursor',
        createdAt: '2026-11-10T09:00:00.000Z',
      },
    ],
    steps: [
      step(1, 'implement', 2.5, '2026-11-08T11:00:00.000Z'),
      step(1, 'code-review-quality', 0.5, '2026-11-08T12:00:00.000Z', { model: 'model-b' }),
      step(1, 'commit', 0, '2026-11-08T12:10:00.000Z'),
      step(2, 'implement', 0, '2026-11-10T00:10:00.000Z', { model: 'gpt', tokensIn: 500 }),
      step(3, 'plan', 1, '2026-11-10T08:30:00.000Z'),
      step(4, 'implement', 0.25, '2026-11-10T09:30:00.000Z'),
    ],
    loops: [
      { runId: 1, counter: 'review', reason: 'review_quality,review_security', createdAt: '2026-11-08T11:30:00.000Z' },
      { runId: 1, counter: 'pipeline', reason: 'lint failed', createdAt: '2026-11-08T12:30:00.000Z' },
      { runId: 3, counter: 'review', reason: 'review_quality', createdAt: '2026-11-10T08:40:00.000Z' },
    ],
    stalls: [],
    person: NO_PERSON,
  };
}

describe('buildStats', () => {
  const durations = new Map([
    [1, 3_600_000],
    [4, 600_000],
  ]);

  it('counts runs, spend, tokens, returns and first-pass runs', () => {
    const stats = buildStats(rows(), durations, NOW, { days: 7, tzOffset: WARSAW });

    expect(stats.totals).toEqual({
      runs: 4,
      done: 2,
      active: 1,
      failed: 1,
      usd: 4.25,
      tokensIn: 4500,
      tokensOut: 400,
      reviewReturns: 2,
      pipelineReturns: 1,
      returnsByKind: [
        { kind: 'review', returns: 2 },
        { kind: 'pipeline', returns: 1 },
      ],
      firstPass: 1,
      limits: 0,
      agentMs: 5 * 60_000,
      medianDoneMs: 2_100_000,
      merged: 0,
      closed: 0,
      medianToMergeMs: null,
      requirementsMet: 0,
      requirementsTotal: 0,
      caughtAndFixed: 0,
      personMessages: 0,
    });
    expect(stats.tasks).toEqual({
      finished: 2,
      active: 1,
      failed: 1,
      medianUsd: 1.63,
      medianMs: 2_100_000,
      back: 1,
      medianReturns: 1,
    });
    expect(stats.epics).toEqual({
      finished: 0,
      active: 0,
      failed: 0,
      medianUsd: 0,
      medianMs: null,
      back: 0,
      medianReturns: null,
    });
  });

  it('fills every local day of the range and puts each thing on its own day', () => {
    const stats = buildStats(rows(), durations, NOW, { days: 7, tzOffset: WARSAW });

    expect(stats.from).toBe('2026-11-04');
    expect(stats.to).toBe('2026-11-10');
    expect(stats.days).toHaveLength(7);
    const byDay = Object.fromEntries(stats.days.map((day) => [day.day, day]));
    // run-b started at 23:30 UTC, which is the next day in Warsaw.
    expect(byDay['2026-11-09']).toMatchObject({ done: 0, failed: 0, active: 0 });
    expect(byDay['2026-11-10']).toMatchObject({ done: 1, active: 1, failed: 1, usd: 1.25, returns: 1 });
    expect(byDay['2026-11-08']).toMatchObject({ done: 1, usd: 3, returns: 2 });
  });

  it('splits returns by reviewer and keeps CI apart', () => {
    const stats = buildStats(rows(), durations, NOW, { days: 7, tzOffset: WARSAW });

    expect(stats.reasons).toEqual([
      { name: 'quality', returns: 2 },
      { name: 'pipeline', returns: 1 },
      { name: 'security', returns: 1 },
    ]);
    expect(stats.returnsPerRun).toEqual([
      { returns: '0', runs: 2 },
      { returns: '1', runs: 1 },
      { returns: '2', runs: 1 },
      { returns: '3', runs: 0 },
      { returns: '4+', runs: 0 },
    ]);
  });

  it('sums the edits through the shell of every step of a run', () => {
    const data = rows();
    data.steps = [
      step(1, 'implement', 2.5, '2026-11-08T11:00:00.000Z', { shellEdits: 4 }),
      step(1, 'implement', 0.5, '2026-11-08T12:00:00.000Z', { shellEdits: 3 }),
      step(3, 'plan', 1, '2026-11-10T08:30:00.000Z'),
    ];
    const stats = buildStats(data, durations, NOW, { days: 7, tzOffset: WARSAW });
    expect(Object.fromEntries(stats.runs.map((run) => [run.key, run.shellEdits]))).toEqual({
      'run-a': 7,
      'run-b': 0,
      'run-c': 0,
      'run-d': 0,
    });
  });

  it('ranks where the money went and leaves out steps that spent nothing', () => {
    const stats = buildStats(rows(), durations, NOW, { days: 7, tzOffset: WARSAW });

    expect(stats.steps.map((entry) => [entry.name, entry.usd, entry.count])).toEqual([
      ['implement', 2.75, 3],
      ['plan', 1, 1],
      ['code-review-quality', 0.5, 1],
    ]);
    expect(stats.models.map((entry) => entry.name)).toEqual(['model-a', 'model-b', 'gpt']);
    expect(stats.agents.map((entry) => [entry.name, entry.count, entry.usd])).toEqual([
      ['claude', 2, 4],
      ['codex', 1, 0],
      ['cursor', 1, 0.25],
    ]);
  });

  it('adds the cost of a ping to its run, step, model, agent and day, and counts it as no visit and no agent time', () => {
    const base = buildStats(rows(), durations, NOW, { days: 7, tzOffset: WARSAW });
    const data = rows();
    data.steps.push(step(1, 'implement', 0.5, '2026-11-08T13:00:00.000Z', { ping: true, runtime: 'claude' }));

    const stats = buildStats(data, durations, NOW, { days: 7, tzOffset: WARSAW });

    expect(stats.totals).toMatchObject({ usd: 4.75, tokensIn: 5500, tokensOut: 500, agentMs: base.totals.agentMs });
    expect(stats.steps.find((entry) => entry.name === 'implement')).toMatchObject({ usd: 3.25, count: 3 });
    expect(stats.models.find((entry) => entry.name === 'model-a')).toMatchObject({ usd: 4.25, count: 3 });
    expect(stats.agents.find((entry) => entry.name === 'claude')).toMatchObject({ count: 2, usd: 4.5 });
    expect(stats.runs.find((entry) => entry.key === 'run-a')?.usd).toBe(3.5);
    expect(stats.days.find((entry) => entry.day === '2026-11-08')?.usd).toBe(3.5);
  });

  it('charges a step to the runtime it recorded, and to the runtime of its run when it recorded none', () => {
    const data = rows();
    data.steps = [
      step(1, 'implement', 2.5, '2026-11-08T11:00:00.000Z', { runtime: 'codex' }),
      step(1, 'code-review-quality', 0.5, '2026-11-08T12:00:00.000Z'),
      step(3, 'plan', 1, '2026-11-10T08:30:00.000Z'),
    ];
    const stats = buildStats(data, durations, NOW, { days: 7, tzOffset: WARSAW });
    expect(stats.agents.map((entry) => [entry.name, entry.count, entry.usd])).toEqual([
      ['claude', 2, 1.5],
      ['codex', 2, 2.5],
      ['cursor', 1, 0],
    ]);
  });

  it('counts a switched step under the agent that did the work and the limited launch apart, as a limit', () => {
    const data = rows();
    data.steps = [
      step(1, 'code-review-quality', 0.5, '2026-11-08T12:00:00.000Z', {
        runtime: 'claude',
        model: 'claude-opus-5-5',
        status: 'interrupted',
        killReason: 'RUNTIME_LIMIT',
      }),
      step(1, 'code-review-quality', 1, '2026-11-08T12:01:00.000Z', { runtime: 'codex', model: 'gpt-6.1-sol' }),
    ];
    const stats = buildStats(data, durations, NOW, { days: 7, tzOffset: WARSAW });
    expect(stats.totals.limits).toBe(1);
    expect(stats.steps).toEqual([{ name: 'code-review-quality', usd: 1.5, tokens: 2200, count: 1 }]);
    expect(stats.models.map((entry) => [entry.name, entry.usd, entry.count])).toEqual([
      ['gpt-6.1-sol', 1, 1],
      ['claude-opus-5-5', 0.5, 0],
    ]);
  });

  it('groups the spend by the effort of the visit, and names the visits without one runtime default', () => {
    const data = rows();
    data.steps = [
      step(1, 'plan', 2, '2026-11-08T12:00:00.000Z', { effort: 'high' }),
      step(1, 'implement', 1, '2026-11-08T12:01:00.000Z', { effort: 'high' }),
      step(1, 'code-review-quality', 4, '2026-11-08T12:02:00.000Z', { effort: 'xhigh' }),
      step(1, 'implement-improve', 0.5, '2026-11-08T12:03:00.000Z'),
    ];
    const stats = buildStats(data, durations, NOW, { days: 7, tzOffset: WARSAW });
    expect(stats.efforts.map((entry) => [entry.name, entry.usd, entry.tokens, entry.count])).toEqual([
      ['xhigh', 4, 1100, 1],
      ['high', 3, 2200, 2],
      ['runtime default', 0.5, 1100, 1],
    ]);
  });

  it('counts merged and closed runs apart, still in the done bar, with the median time to merge', () => {
    const data = rows();
    const merge = (at: string) => JSON.stringify({ merged: { 'acme/demo': { sha: 'abc', by: 'ada', at } } });
    Object.assign(data.runs[0], {
      state: 'merged',
      doneAt: '2026-11-08T12:00:00.000Z',
      mergeOutcome: merge('2026-11-08T14:00:00.000Z'),
    });
    Object.assign(data.runs[3], {
      state: 'merged',
      doneAt: '2026-11-10T10:00:00.000Z',
      mergeOutcome: merge('2026-11-10T10:30:00.000Z'),
    });
    data.runs.push({
      id: 5,
      key: 'run-e',
      prompt: null,
      status: 'done',
      runtime: 'claude',
      createdAt: '2026-11-08T15:00:00.000Z',
      state: 'closed',
      doneAt: '2026-11-08T16:00:00.000Z',
      mergeOutcome: JSON.stringify({ closed: { repo: 'acme/demo', by: 'grace', at: '2026-11-09T08:00:00.000Z' } }),
    });
    const stats = buildStats(data, durations, NOW, { days: 7, tzOffset: WARSAW });

    expect(stats.totals).toMatchObject({ done: 3, merged: 2, closed: 1, medianToMergeMs: 4_500_000 });
    const byDay = Object.fromEntries(stats.days.map((day) => [day.day, day]));
    expect(byDay['2026-11-08']).toMatchObject({ done: 2, merged: 1, closed: 1, medianToMergeMs: 7_200_000 });
    expect(byDay['2026-11-10']).toMatchObject({ merged: 1, closed: 0, medianToMergeMs: 1_800_000 });
    expect(byDay['2026-11-09'].medianToMergeMs).toBeNull();
  });

  it('lists every run, newest first, with its name, spend and returns', () => {
    const stats = buildStats(rows(), durations, NOW, { days: 7, tzOffset: WARSAW });

    expect(stats.runs.map((run) => [run.key, run.name, run.usd, run.returns, run.outcome])).toEqual([
      ['run-d', 'One pass', 0.25, 0, 'done'],
      ['run-c', 'Fix the bug', 1, 1, 'active'],
      ['run-b', 'run-b', 0, 0, 'failed'],
      ['run-a', 'Add a stats page', 3, 2, 'done'],
    ]);
  });

  it('counts the server stalls on the local day they started, by kind', () => {
    const stall = (kind: 'server-blocked' | 'host-paused', startedAt: string, durationMs: number) => ({
      kind,
      startedAt,
      durationMs,
    });
    const stalls = [
      stall('server-blocked', '2026-11-08T10:00:00.000Z', 20_000),
      stall('server-blocked', '2026-11-08T12:00:00.000Z', 30_000),
      stall('host-paused', '2026-11-08T13:00:00.000Z', 40_000),
    ];

    const stats = buildStats({ ...rows(), stalls }, durations, NOW, { days: 7, tzOffset: WARSAW });

    const byDay = Object.fromEntries(stats.days.map((day) => [day.day, day]));
    expect(byDay['2026-11-08']).toMatchObject({ stalls: { 'server-blocked': 2, 'host-paused': 1 }, stalledMs: 90_000 });
    expect(byDay['2026-11-09']).toMatchObject({ stalls: { 'server-blocked': 0, 'host-paused': 0 }, stalledMs: 0 });
  });

  it('starts no earlier than the first run of all, and has one day and no median without runs', () => {
    expect(buildStats(rows(), durations, NOW, { days: 0, tzOffset: 0 }).from).toBe('2026-11-01');
    expect(buildStats(rows(), durations, NOW, { days: 30, tzOffset: 0 }).from).toBe('2026-11-01');
    const empty = buildStats(
      { firstRunAt: null, runs: [], steps: [], loops: [], stalls: [], person: NO_PERSON },
      new Map(),
      NOW,
      {
        days: 0,
        tzOffset: 0,
      },
    );
    expect(empty.days).toHaveLength(1);
    expect(empty.totals.medianDoneMs).toBeNull();
    expect(empty.runs).toEqual([]);
  });
});

describe('stats range', () => {
  it('starts at local midnight of the first day', () => {
    expect(rangeStart(NOW, { days: 1, tzOffset: WARSAW })).toBe('2026-11-09T23:00:00.000Z');
    expect(rangeStart(NOW, { days: 7, tzOffset: 0 })).toBe('2026-11-04T00:00:00.000Z');
    expect(rangeStart(NOW, { days: 0, tzOffset: 0 })).toBeNull();
    expect(localDay('2026-11-09T23:30:00.000Z', WARSAW)).toBe('2026-11-10');
  });

  it('counts blocked as failed and waiting as active', () => {
    expect(['done', 'failed', 'blocked', 'waiting', 'running'].map(outcomeOf)).toEqual([
      'done',
      'failed',
      'failed',
      'active',
      'active',
    ]);
  });

  it('refuses a range that is not a whole number of days', async () => {
    const controller = new StatsController(
      {
        read: async () => ({
          firstRunAt: null,
          runs: [],
          steps: [],
          loops: [],
          stalls: [],
          person: NO_PERSON,
          durationRows: { stats: [], reportMs: new Map() },
          documents: [],
        }),
      } as never,
      { durationByRun: async () => new Map() } as never,
      { now: () => NOW, iso: () => new Date(NOW).toISOString() },
    );
    await expect(controller.report('7.5')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.report('30', '9999')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.report(undefined, '-60')).resolves.toMatchObject({ to: '2026-11-10' });
  });

  it('titles a run by its stored title, else by its requirements or prompt, and keeps the name', () => {
    const at = '2026-11-10T08:00:00.000Z';
    const row = (id: number, extra: Partial<StatsRows['runs'][number]> = {}) => ({
      id,
      key: `run-${id}`,
      prompt: '# Add a field to the list',
      status: 'done',
      runtime: 'claude',
      createdAt: at,
      ...extra,
    });
    const stats = buildStats(
      {
        firstRunAt: at,
        runs: [row(1, { title: 'Stored title' }), row(2)],
        steps: [],
        loops: [],
        stalls: [],
        person: NO_PERSON,
      },
      new Map(),
      NOW,
      { days: 7, tzOffset: WARSAW },
    );
    expect(stats.runs.map((run) => run.title)).toEqual(['Stored title', 'Add a field to the list']);
    expect(stats.runs[1].name).toBe('# Add a field to the list');
  });

  describe('kinds of returns and tasks', () => {
    const at = '2026-11-10T08:00:00.000Z';
    const run = (id: number, extra: Partial<StatsRows['runs'][number]> = {}) => ({
      id,
      key: `run-${id}`,
      prompt: null,
      status: 'done',
      runtime: 'claude',
      createdAt: at,
      ...extra,
    });
    const view = (loops: StatsRows['loops'], runs = [run(1)], steps: StatsRows['steps'] = []) =>
      buildStats({ firstRunAt: at, runs, steps, loops, stalls: [], person: NO_PERSON }, new Map(), NOW, {
        days: 7,
        tzOffset: WARSAW,
      });

    it('counts each loop counter as its own kind and old checks returns as checks', () => {
      const stats = view([
        { runId: 1, counter: 'checks', reason: 'required checks failed', createdAt: at },
        { runId: 1, counter: 'implement', reason: 'required checks failed', createdAt: at },
        { runId: 1, counter: 'review', reason: 'review_quality,review_security', createdAt: at },
        { runId: 1, counter: 'pipeline', reason: 'g/p lint', createdAt: at },
        { runId: 1, counter: 'adopted', reason: 'adopted 2 commits', createdAt: at },
      ]);

      expect(stats.totals.returnsByKind).toEqual([
        { kind: 'checks', returns: 2 },
        { kind: 'adopted', returns: 1 },
        { kind: 'pipeline', returns: 1 },
        { kind: 'review', returns: 1 },
      ]);
      expect(stats.reasons.map(({ name, returns }) => [name, returns])).toEqual([
        ['checks', 2],
        ['adopted', 1],
        ['pipeline', 1],
        ['quality', 1],
        ['security', 1],
      ]);
    });

    it('does not count a stall line as a return', () => {
      const stats = view([
        {
          runId: 1,
          counter: 'stall',
          reason: 'Stalled for 15 min with no reason; resumed (try 1 of 3)',
          createdAt: at,
        },
      ]);

      expect(stats.totals.returnsByKind).toEqual([]);
    });

    it('opens the checks bar to the commands that failed most', () => {
      const detail = (...commands: string[]) => JSON.stringify({ commands });
      const stats = view([
        {
          runId: 1,
          counter: 'checks',
          reason: 'required checks failed',
          detail: detail('npm run lint'),
          createdAt: at,
        },
        {
          runId: 1,
          counter: 'checks',
          reason: 'required checks failed',
          detail: detail('npm run lint', 'npm test'),
          createdAt: at,
        },
        { runId: 1, counter: 'checks', reason: 'required checks failed', createdAt: at },
      ]);

      expect(stats.reasons).toEqual([
        {
          name: 'checks',
          returns: 3,
          commands: [
            { name: 'npm run lint', returns: 2 },
            { name: 'npm test', returns: 1 },
          ],
        },
      ]);
    });

    it('splits CI returns into CI only, with job names, and CI and checks', () => {
      const pipeline = (detail?: object) => ({
        runId: 1,
        counter: 'pipeline',
        reason: 'x',
        detail: detail && JSON.stringify(detail),
        createdAt: at,
      });
      const stats = view([
        pipeline({ ciOnly: true, jobs: ['docker'] }),
        pipeline({ ciOnly: true, jobs: ['docker', 'e2e'] }),
        pipeline({ ciOnly: false, jobs: ['lint'] }),
        pipeline(),
      ]);

      expect(stats.ciReturns).toEqual({
        only: 2,
        withChecks: 2,
        jobs: [
          { name: 'docker', returns: 2 },
          { name: 'e2e', returns: 1 },
        ],
      });
    });

    it('takes the mean and the median spend of a task in cents', () => {
      const runs = [run(1), run(2), run(3)];
      const steps = [step(1, 'implement', 2, at), step(2, 'implement', 4, at), step(3, 'implement', 30, at)];

      const { tasks } = view([], runs, steps);

      expect([tasks.finished, tasks.medianUsd]).toEqual([3, 4]);
    });

    it('counts a split run with its subtasks as one task', () => {
      const runs = [run(1), run(2, { parentRunId: 1 }), run(3, { parentRunId: 1, status: 'blocked' })];
      const steps = [step(1, 'plan', 1, at), step(2, 'implement', 3, at), step(3, 'implement', 3, at)];
      const loops = [{ runId: 2, counter: 'review', reason: 'review_quality', createdAt: at }];

      const { epics, tasks } = view(loops, runs, steps);

      expect([epics.finished, epics.medianUsd, epics.back, epics.medianReturns]).toEqual([1, 7, 1, 1]);
      expect([tasks.finished, tasks.failed, tasks.back]).toEqual([1, 1, 1]);
    });

    it('counts a split run once, by its parent, with its subtasks in its spend and returns', () => {
      const runs = [
        run(1, { status: 'done', state: 'merged' }),
        run(2, { parentRunId: 1, state: 'merged' }),
        run(3, { parentRunId: 1, status: 'failed' }),
        run(4, { parentRunId: 1, status: 'waiting' }),
        run(5, { status: 'running' }),
      ];
      const steps = [step(1, 'plan', 1, at), step(2, 'implement', 3, at), step(3, 'implement', 2, at)];
      const loops = [{ runId: 2, counter: 'review', reason: 'review_quality', createdAt: at }];

      const stats = view(loops, runs, steps);
      const day = stats.days.find((entry) => entry.day === localDay(at, WARSAW));

      expect([stats.totals.runs, stats.totals.done, stats.totals.active, stats.totals.failed]).toEqual([2, 1, 1, 0]);
      expect([day?.done, day?.active, day?.failed]).toEqual([1, 1, 0]);
      expect([day?.epics, day?.tasks]).toEqual([
        { done: 1, active: 0, failed: 0 },
        { done: 1, active: 2, failed: 1 },
      ]);
      expect(stats.totals.merged).toBe(1);
      expect(stats.runs).toHaveLength(2);
      expect(stats.runs.find((entry) => entry.key === 'run-1')).toMatchObject({ usd: 6, returns: 1 });
      expect(stats.agents.map(({ name, count }) => [name, count])).toEqual([['claude', 5]]);
    });
  });

  describe('quality and person totals', () => {
    const range = { days: 7, tzOffset: 0 };
    const durations = new Map<number, number>();
    const merged = { state: 'merged' as const };
    const doc = (runId: number, kind: string, body: unknown) => ({ runId, kind, body: JSON.stringify(body) });
    const list = (runId: number, count: number) =>
      doc(
        runId,
        'requirement_list',
        Array.from({ length: count }, (_, index) => ({ id: `R${index + 1}`, text: 't' })),
      );
    const marks = (runId: number, ...statuses: string[]) =>
      doc(runId, 'review_requirements_result', {
        decision: 'ok',
        review: 'r',
        summary: ['s'],
        requirements: statuses.map((status, index) => ({ id: `R${index + 1}`, status, note: 'n' })),
      });
    const chat = (...entries: object[]) => JSON.stringify({ entries, revisions: [] });
    const entry = (key: string, extra: object = {}) => ({
      key,
      role: 'person',
      author: 'ada',
      text: 't',
      at: '2026-11-09T10:00:00.000Z',
      state: 'taken',
      ...extra,
    });

    it('sums the requirements of merged runs from the last round, and a run without statuses or a closed run adds nothing', () => {
      const data = rows();
      Object.assign(data.runs[0], merged);
      Object.assign(data.runs[3], merged);
      Object.assign(data.runs[1], { state: 'closed' });
      const stats = buildStats(data, durations, NOW, range, new Map(), [
        list(1, 3),
        marks(1, 'met', 'partial', 'met'),
        list(4, 2),
        list(2, 5),
        marks(2, 'met', 'met', 'met', 'met', 'met'),
      ]);
      expect(stats.totals).toMatchObject({ requirementsMet: 2, requirementsTotal: 3 });
    });

    it('counts the last requirements round, and a last round with no per-id statuses adds nothing', () => {
      const data = rows();
      Object.assign(data.runs[0], merged);
      Object.assign(data.runs[3], merged);
      const empty = doc(4, 'review_requirements_result', {
        decision: 'ok',
        review: 'r',
        summary: ['s'],
        requirements: [],
      });
      const stats = buildStats(data, durations, NOW, range, new Map(), [
        list(1, 3),
        marks(1, 'partial', 'partial', 'partial'),
        marks(1, 'met', 'met', 'partial'),
        list(4, 2),
        empty,
      ]);
      expect(stats.totals).toMatchObject({ requirementsMet: 2, requirementsTotal: 3 });
    });

    it('counts the returns of merged runs, subtasks included, and no others', () => {
      const data = rows();
      Object.assign(data.runs[0], merged);
      expect(buildStats(data, durations, NOW, range).totals.caughtAndFixed).toBe(2);
      Object.assign(data.runs[0], { state: 'closed' });
      expect(buildStats(data, durations, NOW, range).totals.caughtAndFixed).toBe(0);
    });

    it('counts what people wrote once, and leaves out the planner, machine runs and answers without a person', () => {
      const data = rows();
      Object.assign(data.runs[0], { startedBy: 'ada' });
      Object.assign(data.runs[1], { startedBy: 'machine' });
      data.person = {
        answers: [{ id: 'c1', createdAt: '2026-11-09T10:00:00.000Z' }],
        planChats: [
          chat(
            entry('message-c1'),
            entry('message-c2'),
            entry('message-c3', { at: '2026-10-01T10:00:00.000Z' }),
            entry('planner-1', { role: 'planner' }),
            entry('q-1', { kind: 'question' }),
          ),
        ],
        backlogMessages: [{ createdAt: '2026-11-09T11:00:00.000Z' }],
      };
      const stats = buildStats(data, durations, NOW, range);
      // run a prompt, the answer, the plan chat message c2, the backlog message
      expect(stats.totals.personMessages).toBe(4);
    });
  });
});
