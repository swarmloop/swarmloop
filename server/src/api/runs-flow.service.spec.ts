import 'reflect-metadata';
import { utimesSync } from 'fs';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { HistoryService } from '../history/history.service';
import { LiveHub } from '../live/live.hub';
import { RunQueriesService } from './run-queries.service';
import { boot, save, visit } from './runs.spec-helpers';

describe('runs api', () => {
  it('does not ask old questions on a later step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-later-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-6', 'commit', 'waiting');
      await history.putDocument(run, 'questions', '- which limit\n');
      await history.finishVisit(run, visit('requirements', 'waiting'));
      const flow = await app.get(RunQueriesService).flow('proj-6');
      expect(flow.items).toEqual([]);
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'requirements')?.status).toBe('done');
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'requirements')?.attempts).toBe(0);
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'prepare')?.attempts).toBe(0);
      await mkdir(join(root, 'data'), { recursive: true });
      await writeFile(join(root, 'data', 'proj-6-requirements-launches.txt'), '1\n1\n');
      const recorded = await app.get(RunQueriesService).flow('proj-6');
      expect(recorded.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'requirements')?.attempts).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('shows a skipped pipeline when there was nowhere to push', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-skip-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-9', 'merge-request', 'waiting');
      await history.putDocument(run, 'ci_skip', 'CI skipped: there is no origin to push.\n');
      await history.finishVisit(run, visit('pipeline', 'skipped'));
      const flow = await app.get(RunQueriesService).flow('proj-9');
      expect(flow.currentStep).toBe('merge-request');
      expect(flow.sentence).toContain('CI skipped: there is no origin to push.');
      expect(flow.sentence).toContain('merge-request');
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'pipeline')?.status).toBe('skipped');
    } finally {
      await app.close();
    }
  });

  it('shows a returned pipeline as failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-pipe-red-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-pipe-red', 'implement', 'waiting');
      await history.finishVisit(run, visit('pipeline', 'waiting'));
      const flow = await app.get(RunQueriesService).flow('proj-pipe-red');
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'pipeline')?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('shows a returned code review as failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-red-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-review-red', 'implement', 'waiting');
      await history.finishVisit(run, {
        ...visit('code-review', 'waiting'),
        documents: [{ kind: 'review_quality', fileName: '', body: 'notes\ndecision: return\n' }],
      });
      const flow = await app.get(RunQueriesService).flow('proj-review-red');
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'code-review')?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('shows a later green pipeline as done', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-pipe-green-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-pipe-green', 'done', 'done');
      await history.finishVisit(run, visit('pipeline', 'waiting'));
      await history.finishVisit(run, visit('pipeline', 'done'));
      const flow = await app.get(RunQueriesService).flow('proj-pipe-green');
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'pipeline')?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('shows a pipeline rerun as running while the previous visit is waiting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-pipe-run-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-pipe-run', 'pipeline', 'running');
      await history.finishVisit(run, visit('pipeline', 'waiting'));
      const flow = await app.get(RunQueriesService).flow('proj-pipe-run');
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'pipeline')?.status).toBe('running');
    } finally {
      await app.close();
    }
  });

  it('shows the stored failure instead of the status word', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-error-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-8', 'prepare', 'failed');
      await history.putDocument(run, 'error', 'checkouts is empty\n');
      expect((await app.get(RunQueriesService).flow('proj-8')).reason).toBe('checkouts is empty');
    } finally {
      await app.close();
    }
  });

  it('shows a passed reviewer with its chart the same way as any other step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-chart-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-28', 'commit', 'waiting');
      const now = new Date().toISOString();
      await history.finishVisit(run, {
        ...visit('code-review-quality', 'waiting'),
        documents: [{ kind: 'review_quality', fileName: '', body: 'old\ndecision: return\n' }],
      });
      await history.finishVisit(run, {
        ...visit('code-review-quality', 'done'),
        model: 'grok-4.7-high',
        mode: 'ask',
        tokensIn: 12,
        tokensOut: 3,
        samples: [{ sampledAt: now, cpuPercent: 40, rssBytes: 2048 }],
        documents: [
          { kind: 'review_quality', fileName: '', body: 'cleared\ndecision: ok\n' },
          { kind: 'log', fileName: '', body: 'cleared\ndecision: ok\n' },
        ],
        exchange: {
          model: 'grok-4.7-high',
          startedAt: now,
          finishedAt: now,
          durationMs: 10,
          requestText: 'review',
          responseText: 'cleared\ndecision: ok\n',
          chatId: 'q',
          resumed: false,
          killReason: null,
        },
      });
      const runs = app.get(RunQueriesService);
      const detail = await runs.step('proj-28', 'code-review-quality');
      expect(detail.visits.map((item) => [item.attempt, item.status, item.decision])).toEqual([
        [1, 'waiting', 'decision: return'],
        [2, 'done', 'decision: ok'],
      ]);
      expect(detail.visits[1]?.samples).toEqual([{ at: now, cpu: 40, memory: 2048 }]);
      expect(detail.visits[1]?.exchanges).toEqual([
        { model: 'grok-4.7-high', durationMs: 10, request: 'review', response: 'cleared\ndecision: ok\n' },
      ]);
      const chips = (await runs.flow('proj-28')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review-quality')?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('shows a later pass over an earlier return, with that round chart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-second-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-30', 'code-review', 'waiting');
      const now = new Date().toISOString();
      await history.finishVisit(run, {
        ...visit('code-review', 'waiting'),
        samples: [{ sampledAt: now, cpuPercent: 40, rssBytes: 2048 }],
        documents: [{ kind: 'review_requirements', fileName: '', body: 'old\ndecision: return\n' }],
      });
      await mkdir(join(root, 'data'), { recursive: true });
      await writeFile(
        join(root, 'data', 'proj-30-code-review-requirements-output.txt'),
        `old\ndecision: return\n${JSON.stringify({ type: 'result', result: 'cleared\ndecision: ok\n' })}\nprocess exited 0\n`,
      );
      const runs = app.get(RunQueriesService);
      const detail = await runs.step('proj-30', 'code-review-requirements');
      expect(detail.visits.at(-1)?.status).toBe('done');
      expect(detail.visits.at(-1)?.decision).toBe('decision: ok');
      expect(detail.visits.at(-1)?.samples).toEqual([{ at: now, cpu: 40, memory: 2048 }]);
      const chips = (await runs.flow('proj-30')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review-requirements')?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('shows why implement returned on the latest visit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-return-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-21', 'implement', 'waiting');
      await history.finishVisit(run, visit('implement', 'done'));
      await history.putDocument(run, 'review_quality', 'use theme.alpha\ndecision: return\n');
      const step = await app.get(RunQueriesService).step('proj-21', 'implement');
      expect(step.visits.at(-1)?.documents.some((item) => item.kind === 'return' && item.body.includes('use theme.alpha'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('shows one code reviewer running and leaves the report until the end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-reviewers-'));
    const app = await boot(root);
    try {
      await mkdir(join(root, 'data'), { recursive: true });
      await writeFile(
        join(root, 'data', 'proj-20-code-review-quality-output.txt'),
        `${JSON.stringify({ type: 'thinking', text: 'look' })}\n${JSON.stringify({ type: 'result', result: 'notes\ndecision: ok\n', usage: { inputTokens: 8, outputTokens: 2 } })}\nprocess exited 0\n`,
      );
      await writeFile(join(root, 'data', 'proj-20-code-review-security-output.txt'), `${JSON.stringify({ type: 'thinking', text: 'still' })}\n`);
      await save(app.get(HistoryService), 'proj-20', 'code-review', 'running');
      const runs = app.get(RunQueriesService);
      const flow = await runs.flow('proj-20');
      const chips = flow.phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
      expect(chips.map((step) => step.name)).toEqual([
        'code-review-requirements',
        'code-review-quality',
        'code-review-regressions',
        'code-review-security',
        'code-review-performance',
        'code-review',
      ]);
      expect(chips.find((step) => step.name === 'code-review-requirements')?.status).toBe('idle');
      expect(chips.find((step) => step.name === 'code-review-quality')?.status).toBe('done');
      expect(chips.find((step) => step.name === 'code-review-regressions')?.status).toBe('idle');
      expect(chips.find((step) => step.name === 'code-review-security')?.status).toBe('running');
      expect(chips.find((step) => step.name === 'code-review-performance')?.status).toBe('idle');
      expect(chips.find((step) => step.name === 'code-review')?.status).toBe('idle');
      const quality = await runs.step('proj-20', 'code-review-quality');
      expect(quality.visits.at(-1)?.status).toBe('done');
      expect(quality.visits.at(-1)?.documents.some((item) => item.body.includes('"look"'))).toBe(true);
      const security = await runs.step('proj-20', 'code-review-security');
      expect(security.visits.at(-1)?.status).toBe('running');
    } finally {
      await app.close();
    }
  });

  it('leaves a starting reviewer idle while code-review is running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-starting-'));
    const app = await boot(root);
    try {
      await mkdir(join(root, 'data'), { recursive: true });
      await writeFile(join(root, 'data', 'proj-32-code-review-requirements-output.txt'), 'starting\n');
      await writeFile(join(root, 'data', 'proj-32-code-review-report-output.txt'), 'starting\n');
      await writeFile(join(root, 'data', 'proj-32-code-review-security-output.txt'), `${JSON.stringify({ type: 'thinking', text: 'still' })}\n`);
      await save(app.get(HistoryService), 'proj-32', 'code-review', 'running');
      const runs = app.get(RunQueriesService);
      const chips = (await runs.flow('proj-32')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review-requirements')?.status).toBe('idle');
      expect(chips.find((step) => step.name === 'code-review-requirements')?.attempts).toBe(0);
      expect(chips.find((step) => step.name === 'code-review')?.status).toBe('idle');
      expect(chips.find((step) => step.name === 'code-review-security')?.status).toBe('running');
      const requirements = await runs.step('proj-32', 'code-review-requirements');
      expect(requirements.visits).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('leaves the report idle while its log is starting and angles are stored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-report-starting-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      await mkdir(join(root, 'data'), { recursive: true });
      const ok = await save(history, 'proj-33', 'code-review', 'running');
      await writeFile(join(root, 'data', 'proj-33-code-review-report-output.txt'), 'starting\n');
      await history.finishVisit(ok, {
        ...visit('code-review', 'done'),
        documents: [{ kind: 'review_quality', fileName: '', body: 'notes\ndecision: ok\n' }],
      });
      const returned = await save(history, 'proj-34', 'code-review', 'running');
      await writeFile(join(root, 'data', 'proj-34-code-review-report-output.txt'), 'starting\n');
      await history.finishVisit(returned, {
        ...visit('code-review', 'waiting'),
        documents: [{ kind: 'review_quality', fileName: '', body: 'notes\ndecision: return\n' }],
      });
      const runs = app.get(RunQueriesService);
      const chip = async (key: string) =>
        (await runs.flow(key)).phases.find((phase) => phase.phase === 'code review')?.steps.find((step) => step.name === 'code-review');
      expect((await chip('proj-33'))?.status).toBe('idle');
      expect((await chip('proj-34'))?.status).toBe('idle');
      await writeFile(join(root, 'data', 'proj-33-code-review-report-output.txt'), 'process started\n');
      expect((await chip('proj-33'))?.status).toBe('running');
    } finally {
      await app.close();
    }
  });

  it('keeps a finished reviewer chart from the retained samples while code-review runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-live-chart-'));
    const app = await boot(root);
    try {
      await mkdir(join(root, 'data'), { recursive: true });
      await writeFile(
        join(root, 'data', 'proj-31-code-review-quality-output.txt'),
        `${JSON.stringify({ type: 'result', result: 'notes\ndecision: ok\n' })}\nprocess exited 0\n`,
      );
      await save(app.get(HistoryService), 'proj-31', 'code-review', 'running');
      const now = new Date().toISOString();
      app.get(LiveHub).log({
        key: 'proj-31',
        step: 'code-review-quality',
        body: 'notes\ndecision: ok\n',
        samples: [{ at: now, cpu: 40, memory: 2048 }],
      });
      const quality = await app.get(RunQueriesService).step('proj-31', 'code-review-quality');
      expect(quality.visits.at(-1)?.status).toBe('done');
      expect(quality.visits.at(-1)?.samples).toEqual([{ at: now, cpu: 40, memory: 2048 }]);
    } finally {
      await app.close();
    }
  });

  it('keeps passed reviewers green when code-review failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-fail-'));
    const app = await boot(root);
    try {
      await mkdir(join(root, 'data'), { recursive: true });
      await writeFile(
        join(root, 'data', 'proj-22-code-review-quality-output.txt'),
        `${JSON.stringify({ type: 'result', result: 'notes\ndecision: ok\n' })}\nprocess exited 0\n`,
      );
      await writeFile(
        join(root, 'data', 'proj-22-code-review-performance-output.txt'),
        `${JSON.stringify({ type: 'thinking', text: 'nope' })}\nprocess exited 0\n`,
      );
      await save(app.get(HistoryService), 'proj-22', 'code-review', 'failed');
      const chips = (await app.get(RunQueriesService).flow('proj-22')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review-requirements')?.status).toBe('idle');
      expect(chips.find((step) => step.name === 'code-review-quality')?.status).toBe('done');
      expect(chips.find((step) => step.name === 'code-review-performance')?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('does not count a recover visit on a reviewer that did not run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-attempts-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-25', 'code-review', 'waiting');
      await mkdir(join(root, 'data'), { recursive: true });
      await writeFile(join(root, 'data', 'proj-25-code-review-quality-launches.txt'), '1\n');
      await history.finishVisit(run, {
        ...visit('code-review', 'done'),
        documents: [{ kind: 'review_quality', fileName: '', body: 'notes\ndecision: ok\n' }],
      });
      await history.finishVisit(run, { ...visit('code-review', 'waiting'), documents: [] });
      const chips = (await app.get(RunQueriesService).flow('proj-25')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review-quality')?.attempts).toBe(1);
      const quality = await app.get(RunQueriesService).step('proj-25', 'code-review-quality');
      expect(quality.visits).toHaveLength(1);
      expect(quality.visits[0]?.status).toBe('done');
      expect(quality.visits[0]?.attempt).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('keeps a later ok round green when the report repeats an earlier return', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-report-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-27', 'commit', 'failed');
      const angles = ['requirements', 'quality', 'regressions', 'security', 'performance'];
      await history.finishVisit(run, {
        ...visit('code-review', 'waiting'),
        documents: [
          ...angles.map((name) => ({ kind: `review_${name}`, fileName: '', body: `old\ndecision: ${name === 'security' ? 'ok' : 'return'}\n` })),
          { kind: 'review_report', fileName: '', body: 'The five reviews together are a return.\n' },
        ],
      });
      await history.finishVisit(run, {
        ...visit('code-review', 'done'),
        documents: [
          ...angles.map((name) => ({ kind: `review_${name}`, fileName: '', body: `cleared\ndecision: ok\n` })),
          { kind: 'review_report', fileName: '', body: 'Four of the five angles return.\n\ndecision: return\n' },
        ],
      });
      const detail = await app.get(RunQueriesService).step('proj-27', 'code-review');
      expect(detail.visits.map((item) => [item.attempt, item.status, item.decision])).toEqual([
        [1, 'waiting', 'decision: return'],
        [2, 'done', 'decision: ok'],
      ]);
      const chips = (await app.get(RunQueriesService).flow('proj-27')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review')?.status).toBe('done');
      expect(chips.find((step) => step.name === 'code-review-quality')?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('numbers a reviewer by its own visits, not the shared code-review round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-numbers-'));
    const app = await boot(root);
    try {
      await mkdir(join(root, 'data'), { recursive: true });
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-26', 'code-review', 'running');
      await history.finishVisit(run, {
        ...visit('code-review', 'done'),
        documents: [{ kind: 'review_performance', fileName: '', body: 'notes\ndecision: ok\n' }],
      });
      await history.finishVisit(run, { ...visit('code-review', 'waiting'), documents: [] });
      await history.finishVisit(run, { ...visit('code-review', 'waiting'), documents: [] });
      await history.finishVisit(run, { ...visit('code-review', 'waiting'), documents: [] });
      await writeFile(join(root, 'data', 'proj-26-code-review-performance-output.txt'), `${JSON.stringify({ type: 'thinking', text: 'again' })}\n`);
      await writeFile(join(root, 'data', 'proj-26-code-review-performance-launches.txt'), '1\n1\n');
      const chips = (await app.get(RunQueriesService).flow('proj-26')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review-performance')?.attempts).toBe(2);
      const performance = await app.get(RunQueriesService).step('proj-26', 'code-review-performance');
      expect(performance.visits.map((item) => item.attempt)).toEqual([1, 2]);
    } finally {
      await app.close();
    }
  });

  it('keeps a first running visit at attempt 1 when the launch record is ahead', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-first-'));
    const app = await boot(root);
    try {
      await mkdir(join(root, 'data'), { recursive: true });
      const history = app.get(HistoryService);
      await save(history, 'proj-32', 'code-review', 'running');
      await writeFile(join(root, 'data', 'proj-32-code-review-regressions-output.txt'), 'thinking\nprocess killed: time\nthinking\n');
      await writeFile(join(root, 'data', 'proj-32-code-review-regressions-launches.txt'), '1\n1\n');
      await writeFile(join(root, 'data', 'proj-32-code-review-quality-output.txt'), 'thinking\n');
      await writeFile(join(root, 'data', 'proj-32-code-review-quality-launches.txt'), '1\n1\n');
      const runs = app.get(RunQueriesService);
      const chips = (await runs.flow('proj-32')).phases.flatMap((phase) => phase.steps);
      expect(chips.find((step) => step.name === 'code-review-regressions')?.attempts).toBe(1);
      expect(chips.find((step) => step.name === 'code-review-regressions')?.status).toBe('running');
      expect(chips.find((step) => step.name === 'code-review-quality')?.attempts).toBe(1);
      expect(chips.find((step) => step.name === 'code-review')?.attempts).toBe(0);
      const regressions = await runs.step('proj-32', 'code-review-regressions');
      expect(regressions.visits.map((item) => item.attempt)).toEqual([1]);
      await writeFile(join(root, 'data', 'proj-32-code-review-report-output.txt'), 'thinking\n');
      await writeFile(join(root, 'data', 'proj-32-code-review-report-launches.txt'), '1\n1\n');
      const reporting = (await runs.flow('proj-32')).phases.flatMap((phase) => phase.steps);
      expect(reporting.find((step) => step.name === 'code-review')?.attempts).toBe(1);
      expect(reporting.find((step) => step.name === 'code-review')?.status).toBe('running');
      await save(history, 'proj-33', 'research', 'running');
      await writeFile(join(root, 'data', 'proj-33-research-output.txt'), 'thinking\n');
      await writeFile(join(root, 'data', 'proj-33-research-launches.txt'), '1\n1\n');
      const researchChips = (await runs.flow('proj-33')).phases.flatMap((phase) => phase.steps);
      expect(researchChips.find((step) => step.name === 'research')?.attempts).toBe(1);
      const research = await runs.step('proj-33', 'research');
      expect(research.visits.map((item) => item.attempt)).toEqual([1]);
    } finally {
      await app.close();
    }
  });

  it('counts a reviewer that continued after the time kill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-relaunched-'));
    const app = await boot(root);
    try {
      await mkdir(join(root, 'data'), { recursive: true });
      await save(app.get(HistoryService), 'proj-29', 'code-review', 'running');
      await writeFile(
        join(root, 'data', 'proj-29-code-review-requirements-output.txt'),
        'thinking\nprocess killed: time\nthinking\nfinishing the review\n',
      );
      await writeFile(join(root, 'data', 'proj-29-research-launches.txt'), '1\n');
      const steps = (await app.get(RunQueriesService).flow('proj-29')).phases.flatMap((phase) => phase.steps);
      expect(steps.find((step) => step.name === 'code-review-requirements')?.attempts).toBe(1);
      expect(steps.find((step) => step.name === 'code-review-requirements')?.status).toBe('running');
      const detail = await app.get(RunQueriesService).step('proj-29', 'code-review-requirements');
      expect(detail.visits.at(-1)?.status).toBe('running');
      expect(detail.visits.map((item) => item.attempt)).toEqual([1]);
      await writeFile(join(root, 'data', 'proj-29-code-review-requirements-output.txt'), 'process killed: time\n');
      await writeFile(join(root, 'data', 'proj-29-code-review-requirements-launches.txt'), '1\n1\n');
      const killed = (await app.get(RunQueriesService).flow('proj-29')).phases.flatMap((phase) => phase.steps);
      expect(killed.find((step) => step.name === 'code-review-requirements')?.attempts).toBe(1);
      expect(killed.find((step) => step.name === 'code-review-requirements')?.status).toBe('failed');
      await writeFile(join(root, 'data', 'proj-29-code-review-requirements-output.txt'), 'process killed: time\nprocess started\n');
      const again = (await app.get(RunQueriesService).flow('proj-29')).phases.flatMap((phase) => phase.steps);
      expect(again.find((step) => step.name === 'code-review-requirements')?.status).toBe('running');
      await writeFile(
        join(root, 'data', 'proj-29-code-review-requirements-output.txt'),
        'notes\ndecision: ok\nprocess exited 0\n',
      );
      await writeFile(join(root, 'data', 'proj-29-code-review-requirements-launches.txt'), '1\n1\n1\n');
      const decided = (await app.get(RunQueriesService).flow('proj-29')).phases.flatMap((phase) => phase.steps);
      expect(decided.find((step) => step.name === 'code-review-requirements')?.attempts).toBe(1);
      expect(decided.find((step) => step.name === 'code-review-requirements')?.status).toBe('done');
      expect(steps.find((step) => step.name === 'research')?.attempts).toBe(0);
      expect(steps.find((step) => step.name === 'prepare')?.attempts).toBe(0);
      expect(steps.find((step) => step.name === 'code-review')?.attempts).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('shows each reviewer its own visit while the code-review round is running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-round-'));
    const app = await boot(root);
    try {
      await mkdir(join(root, 'data'), { recursive: true });
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-round', 'code-review', 'running');
      const round1 = '2026-10-28T10:00:00.000Z';
      const round2 = '2026-10-28T11:00:00.000Z';
      run.stepStartedAt = round1;
      await history.saveRun(run);
      const stored = [
        ['requirements', 'ok', 'done'],
        ['quality', 'return', 'waiting'],
        ['regressions', 'ok', 'done'],
        ['security', 'return', 'waiting'],
        ['performance', 'ok', 'done'],
      ] as const;
      for (const [name, decision, status] of stored) {
        await history.finishVisit(run, {
          ...visit(`code-review-${name}`, status),
          documents: [{ kind: `review_${name}`, fileName: '', body: `round 1\ndecision: ${decision}\n` }],
        });
      }
      run.stepStartedAt = round2;
      await history.saveRun(run);
      const file = (name: string) => join(root, 'data', `proj-round-code-review-${name}-output.txt`);
      await writeFile(file('quality'), 'notes\ndecision: ok\nprocess exited 0\n');
      const older = new Date(Date.parse(round2) - 60_000);
      utimesSync(file('quality'), older, older);
      await writeFile(file('requirements'), 'notes\ndecision: ok\nprocess exited 0\n');
      await writeFile(file('regressions'), 'thinking\n');
      await writeFile(file('performance'), 'notes\ndecision: return\nprocess exited 0\n');
      await writeFile(file('security'), 'starting\n');
      const runs = app.get(RunQueriesService);
      const chips = async () => (await runs.flow('proj-round')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
      const running = await chips();
      const at = (steps: { name: string; status: string; attempts: number }[], name: string) => steps.find((step) => step.name === name);
      expect(at(running, 'code-review-requirements')?.attempts).toBe(2);
      expect(at(running, 'code-review-requirements')?.status).toBe('done');
      expect(at(running, 'code-review-regressions')?.attempts).toBe(2);
      expect(at(running, 'code-review-regressions')?.status).toBe('running');
      expect(at(running, 'code-review-performance')?.attempts).toBe(2);
      expect(at(running, 'code-review-performance')?.status).toBe('waiting');
      expect(at(running, 'code-review-quality')?.attempts).toBe(1);
      expect(at(running, 'code-review-quality')?.status).toBe('waiting');
      expect(at(running, 'code-review-security')?.attempts).toBe(1);
      expect(at(running, 'code-review-security')?.status).toBe('waiting');

      run.status = 'waiting';
      await history.saveRun(run);
      const held = await chips();
      expect(at(held, 'code-review-requirements')?.attempts).toBe(1);
      expect(at(held, 'code-review-requirements')?.status).toBe('done');
      expect(at(held, 'code-review-quality')?.attempts).toBe(1);
      expect(at(held, 'code-review-quality')?.status).toBe('waiting');
      expect(at(held, 'code-review-regressions')?.attempts).toBe(1);
      expect(at(held, 'code-review-regressions')?.status).toBe('done');
      expect(at(held, 'code-review-security')?.attempts).toBe(1);
      expect(at(held, 'code-review-security')?.status).toBe('waiting');
      expect(at(held, 'code-review-performance')?.attempts).toBe(1);
      expect(at(held, 'code-review-performance')?.status).toBe('done');

      run.status = 'running';
      run.currentStep = 'code-review';
      run.stepStartedAt = round2;
      await history.saveRun(run);
      const next = [
        ['requirements', 'return', 'waiting'],
        ['quality', 'ok', 'done'],
        ['regressions', 'return', 'waiting'],
        ['security', 'ok', 'done'],
        ['performance', 'ok', 'done'],
      ] as const;
      for (const [name, decision, status] of next) {
        await history.finishVisit(run, {
          ...visit(`code-review-${name}`, status),
          documents: [{ kind: `review_${name}`, fileName: '', body: `round 2\ndecision: ${decision}\n` }],
        });
      }
      await writeFile(join(root, 'data', 'proj-round-code-review-report-output.txt'), 'thinking\n');
      const saved = await chips();
      expect(at(saved, 'code-review-requirements')?.attempts).toBe(2);
      expect(at(saved, 'code-review-requirements')?.status).toBe('waiting');
      expect(at(saved, 'code-review-quality')?.attempts).toBe(2);
      expect(at(saved, 'code-review-quality')?.status).toBe('done');
      expect(at(saved, 'code-review-regressions')?.attempts).toBe(2);
      expect(at(saved, 'code-review-regressions')?.status).toBe('waiting');
      expect(at(saved, 'code-review-security')?.attempts).toBe(2);
      expect(at(saved, 'code-review-security')?.status).toBe('done');
      expect(at(saved, 'code-review-performance')?.attempts).toBe(2);
      expect(at(saved, 'code-review-performance')?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('keeps a time-kill relaunch on the same reviewer visit in the open round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-kill-'));
    const app = await boot(root);
    try {
      await mkdir(join(root, 'data'), { recursive: true });
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-kill', 'code-review', 'running');
      run.stepStartedAt = '2026-10-28T10:00:00.000Z';
      await history.saveRun(run);
      await history.finishVisit(run, {
        ...visit('code-review-requirements', 'done'),
        documents: [{ kind: 'review_requirements', fileName: '', body: 'round 1\ndecision: ok\n' }],
      });
      run.stepStartedAt = '2026-10-28T11:00:00.000Z';
      await history.saveRun(run);
      const path = join(root, 'data', 'proj-kill-code-review-requirements-output.txt');
      await writeFile(path, 'thinking\nprocess killed: time\n');
      const runs = app.get(RunQueriesService);
      const chip = async () =>
        (await runs.flow('proj-kill')).phases.flatMap((phase) => phase.steps).find((step) => step.name === 'code-review-requirements');
      expect((await chip())?.attempts).toBe(2);
      expect((await chip())?.status).toBe('failed');
      await writeFile(path, 'thinking\nprocess killed: time\nprocess started\n');
      expect((await chip())?.attempts).toBe(2);
      expect((await chip())?.status).toBe('running');
    } finally {
      await app.close();
    }
  });

  it('shows a return as waiting, not done', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-return-'));
    const app = await boot(root);
    try {
      await mkdir(join(root, 'data'), { recursive: true });
      await writeFile(
        join(root, 'data', 'proj-23-code-review-quality-output.txt'),
        `${JSON.stringify({ type: 'result', result: 'notes\ndecision: return\n' })}\nprocess exited 0\n`,
      );
      await save(app.get(HistoryService), 'proj-23', 'code-review', 'failed');
      const chips = (await app.get(RunQueriesService).flow('proj-23')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review-quality')?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('does not paste the step error onto a reviewer that already decided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-error-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-24', 'code-review', 'failed');
      await history.finishVisit(run, {
        ...visit('code-review', 'failed'),
        documents: [
          { kind: 'review_quality', fileName: '', body: 'notes\ndecision: return\n' },
          { kind: 'error', fileName: '', body: 'decision is missing\n' },
        ],
      });
      const bodies =
        (await app.get(RunQueriesService).step('proj-24', 'code-review-quality')).visits
          .at(-1)
          ?.documents.map((item) => item.body)
          .join('\n') ?? '';
      expect(bodies).toContain('decision: return');
      expect(bodies).not.toContain('decision is missing');
    } finally {
      await app.close();
    }
  });

  it('shows the same code-review wall time in the menu and the run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-duration-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await history.begin('proj-duration', 'implement');
      run.stepStartedAt = '2026-10-28T10:00:00.000Z';
      await history.finishVisit(run, { ...visit('implement', 'done'), durationMs: 1_000 });
      run.stepStartedAt = '2026-10-28T10:01:00.000Z';
      await history.finishVisit(run, { ...visit('code-review-quality', 'done'), durationMs: 8_000 });
      await history.finishVisit(run, { ...visit('code-review-security', 'done'), durationMs: 3_000 });
      await history.finishVisit(run, {
        ...visit('code-review', 'done'),
        durationMs: 11_000,
        exchange: {
          model: 'grok-4.7-high',
          startedAt: '2026-10-28T10:01:09.000Z',
          finishedAt: '2026-10-28T10:01:11.000Z',
          durationMs: 2_000,
          requestText: 'Write the report',
          responseText: 'summary',
          chatId: null,
          resumed: false,
          killReason: null,
        },
      });
      run.status = 'done';
      run.currentStep = 'done';
      run.ownerPid = null;
      run.stepStartedAt = null;
      await history.saveRun(run);
      const short = await history.begin('proj-duration-short', 'code-review');
      short.stepStartedAt = '2026-10-28T11:00:00.000Z';
      await history.finishVisit(short, { ...visit('code-review-quality', 'done'), durationMs: 8_000 });
      await history.finishVisit(short, {
        ...visit('code-review', 'done'),
        durationMs: 1_000,
        exchange: {
          model: 'grok-4.7-high',
          startedAt: '2026-10-28T11:00:08.000Z',
          finishedAt: '2026-10-28T11:00:10.000Z',
          durationMs: 2_000,
          requestText: 'Write the report',
          responseText: 'summary',
          chatId: null,
          resumed: false,
          killReason: null,
        },
      });
      short.status = 'done';
      short.currentStep = 'done';
      short.ownerPid = null;
      short.stepStartedAt = null;
      await history.saveRun(short);
      const listed = await app.get(RunQueriesService).list();
      const flow = await app.get(RunQueriesService).flow('proj-duration');
      const shortFlow = await app.get(RunQueriesService).flow('proj-duration-short');
      expect(listed.runs.find((item) => item.key === 'proj-duration')?.durationMs).toBe(12_000);
      expect(flow.metrics.durationMs).toBe(12_000);
      expect(listed.runs.find((item) => item.key === 'proj-duration-short')?.durationMs).toBe(10_000);
      expect(shortFlow.metrics.durationMs).toBe(10_000);
    } finally {
      await app.close();
    }
  });

  it('keeps each code-review loop separate in the menu and the run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-loop-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await history.begin('proj-loop', 'code-review');
      run.stepStartedAt = null;
      const report = (startedAt: string, finishedAt: string, durationMs: number) => ({
        model: 'grok-4.7-high',
        startedAt,
        finishedAt,
        durationMs,
        requestText: 'Write the report',
        responseText: 'summary',
        chatId: null,
        resumed: false,
        killReason: null,
      });
      await history.finishVisit(run, {
        ...visit('code-review-quality', 'done'),
        durationMs: 3_000,
        startedAt: '2026-10-28T10:00:01.000Z',
        finishedAt: '2026-10-28T10:00:04.000Z',
      });
      await history.finishVisit(run, {
        ...visit('code-review', 'waiting'),
        durationMs: 5_000,
        startedAt: '2026-10-28T10:00:00.000Z',
        finishedAt: '2026-10-28T10:00:05.000Z',
        exchange: report('2026-10-28T10:00:04.000Z', '2026-10-28T10:00:05.000Z', 1_000),
      });
      await history.finishVisit(run, {
        ...visit('implement', 'done'),
        durationMs: 4_000,
        startedAt: '2026-10-28T10:10:00.000Z',
        finishedAt: '2026-10-28T10:10:04.000Z',
      });
      await history.finishVisit(run, {
        ...visit('code-review-quality', 'done'),
        durationMs: 4_000,
        startedAt: '2026-10-28T10:20:01.000Z',
        finishedAt: '2026-10-28T10:20:05.000Z',
      });
      await history.finishVisit(run, {
        ...visit('code-review-security', 'done'),
        durationMs: 9_000,
        startedAt: '2026-10-28T10:20:01.000Z',
        finishedAt: '2026-10-28T10:20:10.000Z',
      });
      await history.finishVisit(run, {
        ...visit('code-review', 'done'),
        durationMs: 12_000,
        startedAt: '2026-10-28T10:20:00.000Z',
        finishedAt: '2026-10-28T10:20:12.000Z',
        exchange: report('2026-10-28T10:20:10.000Z', '2026-10-28T10:20:12.000Z', 2_000),
      });
      run.status = 'done';
      run.currentStep = 'done';
      run.ownerPid = null;
      await history.saveRun(run);
      const listed = await app.get(RunQueriesService).list();
      const flow = await app.get(RunQueriesService).flow('proj-loop');
      expect(listed.runs.find((item) => item.key === 'proj-loop')?.durationMs).toBe(21_000);
      expect(flow.metrics.durationMs).toBe(21_000);
    } finally {
      await app.close();
    }
  });

  it('reports closed step time, the open step start, and live session peaks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-clock-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const hub = app.get(LiveHub);
      const run = await history.begin('proj-clock', 'research');
      const started = run.stepStartedAt;
      await history.saveRun(run);
      expect((await history.findRun('proj-clock'))?.stepStartedAt).toBe(started);
      await history.finishVisit(run, {
        ...visit('prepare', 'done'),
        durationMs: 5_000,
        samples: [{ sampledAt: new Date().toISOString(), cpuPercent: 12, rssBytes: 1024 }],
      });
      hub.log({
        key: 'proj-clock',
        step: 'research',
        body: 'live\n',
        samples: [{ at: new Date().toISOString(), cpu: 80, memory: 4096 }],
      });
      const flow = await app.get(RunQueriesService).flow('proj-clock');
      expect(flow.stepStartedAt).toBe(started);
      expect(flow.status).toBe('running');
      expect(flow.metrics.durationMs).toBe(5_000);
      expect(flow.metrics.closedStarts).toEqual([started]);
      expect(flow.metrics.cpuPeak).toBe(80);
      expect(flow.metrics.memPeak).toBe(4096);
      run.stepStartedAt = null;
      await history.saveRun(run);
      await history.finishVisit(run, { ...visit('research', 'failed'), durationMs: 4 });
      const later = await app.get(RunQueriesService).flow('proj-clock');
      expect(later.metrics.closedStarts).toEqual([started]);
      expect(later.metrics.durationMs).toBe(5_004);
      await history.noteFlow('proj-wait', ['requirements'], null);
      const waiting = await history.findRun('proj-wait');
      expect(waiting?.status).toBe('waiting');
      expect(waiting?.stepStartedAt).toBeNull();
    } finally {
      await app.close();
    }
  });
});
