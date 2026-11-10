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
    usd,
    tokensIn: usd > 0 ? 1000 : 0,
    tokensOut: usd > 0 ? 100 : 0,
    durationMs: 60_000,
    finishedAt,
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
      firstPass: 1,
      agentMs: 5 * 60_000,
      medianDoneMs: 2_100_000,
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
});
