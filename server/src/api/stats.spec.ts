import { BadRequestException } from '@nestjs/common';
import type { StatsRows, StatsStepRow } from '../history/stats.repository';
import { buildStats, localDay, outcomeOf, rangeStart } from './stats';
import { StatsController } from './stats.controller';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const WARSAW = -60;

function step(runId: number, name: string, usd: number, finishedAt: string, extra: Partial<StatsStepRow> = {}) {
  return {
    runId,
    step: name,
    runtime: null,
    model: usd > 0 ? 'model-a' : null,
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
      tasks: 2,
      usdPerTask: 1.63,
      medianUsdPerTask: 1.63,
      tasksBack: 1,
      medianReturnsPerTask: 1,
      firstPass: 1,
      limits: 0,
      agentMs: 5 * 60_000,
      medianDoneMs: 2_100_000,
      merged: 0,
      closed: 0,
      medianToMergeMs: null,
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

  it('starts no earlier than the first run of all, and has one day and no median without runs', () => {
    expect(buildStats(rows(), durations, NOW, { days: 0, tzOffset: 0 }).from).toBe('2026-11-01');
    expect(buildStats(rows(), durations, NOW, { days: 30, tzOffset: 0 }).from).toBe('2026-11-01');
    const empty = buildStats({ firstRunAt: null, runs: [], steps: [], loops: [] }, new Map(), NOW, {
      days: 0,
      tzOffset: 0,
    });
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
      { rows: async () => ({ firstRunAt: null, runs: [], steps: [], loops: [] }) } as never,
      { durationByRun: async () => new Map() } as never,
      { now: () => NOW, iso: () => new Date(NOW).toISOString() },
    );
    await expect(controller.report('7.5')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.report('30', '9999')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.report(undefined, '-60')).resolves.toMatchObject({ to: '2026-11-10' });
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
      buildStats({ firstRunAt: at, runs, steps, loops }, new Map(), NOW, { days: 7, tzOffset: WARSAW });

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

      const { totals } = view([], runs, steps);

      expect([totals.tasks, totals.usdPerTask, totals.medianUsdPerTask]).toEqual([3, 12, 4]);
    });

    it('counts a split run with its subtasks as one task', () => {
      const runs = [run(1), run(2, { parentRunId: 1 }), run(3, { parentRunId: 1, status: 'blocked' })];
      const steps = [step(1, 'plan', 1, at), step(2, 'implement', 3, at), step(3, 'implement', 3, at)];
      const loops = [{ runId: 2, counter: 'review', reason: 'review_quality', createdAt: at }];

      const { totals } = view(loops, runs, steps);

      expect([totals.tasks, totals.usdPerTask, totals.tasksBack, totals.medianReturnsPerTask]).toEqual([1, 7, 1, 1]);
    });
  });
});
