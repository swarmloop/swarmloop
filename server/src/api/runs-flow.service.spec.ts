import 'reflect-metadata';

import { mkdir, mkdtemp, writeFile } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { CheckCommandRepository } from '../history/check-command.repository';
import { RunRepository } from '../history/run.repository';

import { DocumentRepository } from '../history/document.repository';

import { VisitRepository } from '../history/visit.repository';

import { LiveHub } from '../live/live.hub';

import { RunQueriesService } from './run-queries.service';

import { boot, save, visit } from '../testing/runs.spec-helpers';

describe('runs api', () => {
  it('does not ask old questions on a later step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-later-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runs, 'proj-6', 'commit', 'waiting');
      await documents.putDocument(run, 'questions', '- which limit\n');
      await visits.finishVisit(run, visit('requirements', 'waiting'));
      const flow = await app.get(RunQueriesService).flow('proj-6');
      expect(flow.items).toEqual([]);
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'requirements')?.status).toBe(
        'done',
      );
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'requirements')?.attempts).toBe(
        0,
      );
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'prepare')?.attempts).toBe(0);
      await mkdir(join(root, 'data'), { recursive: true });
      await writeFile(join(root, 'data', 'proj-6-requirements-launches.txt'), '1\n1\n');
      const recorded = await app.get(RunQueriesService).flow('proj-6');
      expect(
        recorded.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'requirements')?.attempts,
      ).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('shows a skipped pipeline when there was nowhere to push', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-skip-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runs, 'proj-9', 'merge-request', 'waiting');
      await documents.putDocument(run, 'ci_skip', 'CI skipped: there is no origin to push.\n');
      await visits.finishVisit(run, visit('pipeline', 'skipped'));
      const flow = await app.get(RunQueriesService).flow('proj-9');
      expect(flow.currentStep).toBe('merge-request');
      expect(flow.sentence).toContain('CI skipped: there is no origin to push.');
      expect(flow.sentence).toContain('merge-request');
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'pipeline')?.status).toBe(
        'skipped',
      );
    } finally {
      await app.close();
    }
  });

  it('shows a returned pipeline as failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-pipe-red-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runs, 'proj-pipe-red', 'implement', 'waiting');
      await visits.finishVisit(run, visit('pipeline', 'waiting'));
      const flow = await app.get(RunQueriesService).flow('proj-pipe-red');
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'pipeline')?.status).toBe(
        'failed',
      );
    } finally {
      await app.close();
    }
  });

  it('shows a returned code review as failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-red-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runs, 'proj-review-red', 'implement', 'waiting');
      await visits.finishVisit(run, {
        ...visit('code-review', 'waiting'),
        documents: [{ kind: 'review_quality', fileName: '', body: 'notes\ndecision: return\n' }],
      });
      const flow = await app.get(RunQueriesService).flow('proj-review-red');
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'code-review')?.status).toBe(
        'failed',
      );
    } finally {
      await app.close();
    }
  });

  it('shows a later green pipeline as done', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-pipe-green-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runs, 'proj-pipe-green', 'done', 'done');
      await visits.finishVisit(run, visit('pipeline', 'waiting'));
      await visits.finishVisit(run, visit('pipeline', 'done'));
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
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runs, 'proj-pipe-run', 'pipeline', 'running');
      await visits.finishVisit(run, visit('pipeline', 'waiting'));
      const flow = await app.get(RunQueriesService).flow('proj-pipe-run');
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'pipeline')?.status).toBe(
        'running',
      );
    } finally {
      await app.close();
    }
  });

  it('shows the stored failure instead of the status word', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-error-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await save(runs, 'proj-8', 'prepare', 'failed');
      await documents.putDocument(run, 'error', 'checkouts is empty\n');
      expect((await app.get(RunQueriesService).flow('proj-8')).reason).toBe('checkouts is empty');
    } finally {
      await app.close();
    }
  });

  it('shows a passed reviewer with its chart the same way as any other step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-chart-'));
    const app = await boot(root);
    try {
      const runRepository = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runRepository, 'proj-28', 'commit', 'waiting');
      const now = new Date().toISOString();
      await visits.finishVisit(run, {
        ...visit('code-review-quality', 'waiting'),
        documents: [{ kind: 'review_quality', fileName: '', body: 'old\ndecision: return\n' }],
      });
      await visits.finishVisit(run, {
        ...visit('code-review-quality', 'done'),
        model: 'grok-4.7-high',
        mode: 'ask',
        tokensIn: 12,
        tokensOut: 3,
        samples: [{ sampledAt: now, cpuPercent: 40, rssBytes: 2048, source: 'agent' }],
        documents: [{ kind: 'review_quality', fileName: '', body: 'cleared\ndecision: ok\n' }],
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
      expect(detail.visits[1]?.samples).toEqual([{ at: now, cpu: 40, memory: 2048, source: 'agent' }]);
      expect(detail.visits[1]?.exchanges).toEqual([
        { model: 'grok-4.7-high', durationMs: 10, request: 'review', response: 'cleared\ndecision: ok\n' },
      ]);
      const chips = (await runs.flow('proj-28')).phases.find((phase) => phase.phase === 'code-review')?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review-quality')?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('shows a later pass over an earlier return, with that round chart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-second-'));
    const app = await boot(root);
    try {
      const runRepository = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runRepository, 'proj-30', 'code-review', 'waiting');
      const now = new Date().toISOString();
      await visits.finishVisit(run, {
        ...visit('code-review', 'waiting'),
        samples: [{ sampledAt: now, cpuPercent: 40, rssBytes: 2048, source: 'agent' }],
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
      expect(detail.visits.at(-1)?.samples).toEqual([{ at: now, cpu: 40, memory: 2048, source: 'agent' }]);
      const chips = (await runs.flow('proj-30')).phases.find((phase) => phase.phase === 'code-review')?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review-requirements')?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('shows why implement returned on the latest visit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-return-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runs, 'proj-21', 'implement', 'waiting');
      await visits.finishVisit(run, visit('implement', 'done'));
      await documents.putDocument(run, 'review_quality', 'use theme.alpha\ndecision: return\n');
      const step = await app.get(RunQueriesService).step('proj-21', 'implement');
      expect(
        step.visits.at(-1)?.documents.some((item) => item.kind === 'return' && item.body.includes('use theme.alpha')),
      ).toBe(true);
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
      await writeFile(
        join(root, 'data', 'proj-20-code-review-security-output.txt'),
        `${JSON.stringify({ type: 'thinking', text: 'still' })}\n`,
      );
      await save(app.get(RunRepository), 'proj-20', 'code-review', 'running');
      const runs = app.get(RunQueriesService);
      const flow = await runs.flow('proj-20');
      const chips = flow.phases.find((phase) => phase.phase === 'code-review')?.steps ?? [];
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
      await writeFile(
        join(root, 'data', 'proj-32-code-review-security-output.txt'),
        `${JSON.stringify({ type: 'thinking', text: 'still' })}\n`,
      );
      await save(app.get(RunRepository), 'proj-32', 'code-review', 'running');
      const runs = app.get(RunQueriesService);
      const chips = (await runs.flow('proj-32')).phases.find((phase) => phase.phase === 'code-review')?.steps ?? [];
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
      const runRepository = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      await mkdir(join(root, 'data'), { recursive: true });
      const ok = await save(runRepository, 'proj-33', 'code-review', 'running');
      await writeFile(join(root, 'data', 'proj-33-code-review-report-output.txt'), 'starting\n');
      await visits.finishVisit(ok, {
        ...visit('code-review', 'done'),
        documents: [{ kind: 'review_quality', fileName: '', body: 'notes\ndecision: ok\n' }],
      });
      const returned = await save(runRepository, 'proj-34', 'code-review', 'running');
      await writeFile(join(root, 'data', 'proj-34-code-review-report-output.txt'), 'starting\n');
      await visits.finishVisit(returned, {
        ...visit('code-review', 'waiting'),
        documents: [{ kind: 'review_quality', fileName: '', body: 'notes\ndecision: return\n' }],
      });
      const runs = app.get(RunQueriesService);
      const chip = async (key: string) =>
        (await runs.flow(key)).phases
          .find((phase) => phase.phase === 'code-review')
          ?.steps.find((step) => step.name === 'code-review');
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
      await save(app.get(RunRepository), 'proj-31', 'code-review', 'running');
      const now = new Date().toISOString();
      app.get(LiveHub).log({
        key: 'proj-31',
        step: 'code-review-quality',
        body: 'notes\ndecision: ok\n',
        samples: [{ at: now, cpu: 40, memory: 2048, source: 'agent' }],
      });
      const quality = await app.get(RunQueriesService).step('proj-31', 'code-review-quality');
      expect(quality.visits.at(-1)?.status).toBe('done');
      expect(quality.visits.at(-1)?.samples).toEqual([{ at: now, cpu: 40, memory: 2048, source: 'agent' }]);
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
      await save(app.get(RunRepository), 'proj-22', 'code-review', 'failed');
      const chips =
        (await app.get(RunQueriesService).flow('proj-22')).phases.find((phase) => phase.phase === 'code-review')
          ?.steps ?? [];
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
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runs, 'proj-25', 'code-review', 'waiting');
      await mkdir(join(root, 'data'), { recursive: true });
      await writeFile(join(root, 'data', 'proj-25-code-review-quality-launches.txt'), '1\n');
      await visits.finishVisit(run, {
        ...visit('code-review', 'done'),
        documents: [{ kind: 'review_quality', fileName: '', body: 'notes\ndecision: ok\n' }],
      });
      await visits.finishVisit(run, { ...visit('code-review', 'waiting'), documents: [] });
      const chips =
        (await app.get(RunQueriesService).flow('proj-25')).phases.find((phase) => phase.phase === 'code-review')
          ?.steps ?? [];
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
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runs, 'proj-27', 'commit', 'failed');
      const angles = ['requirements', 'quality', 'regressions', 'security', 'performance'];
      await visits.finishVisit(run, {
        ...visit('code-review', 'waiting'),
        documents: [
          ...angles.map((name) => ({
            kind: `review_${name}`,
            fileName: '',
            body: `old\ndecision: ${name === 'security' ? 'ok' : 'return'}\n`,
          })),
          { kind: 'review_report', fileName: '', body: 'The five reviews together are a return.\n' },
        ],
      });
      await visits.finishVisit(run, {
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
      const chips =
        (await app.get(RunQueriesService).flow('proj-27')).phases.find((phase) => phase.phase === 'code-review')
          ?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review')?.status).toBe('done');
      expect(chips.find((step) => step.name === 'code-review-quality')?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('shows the checks step with its commands, one chart line per source and the return edge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-checks-'));
    const app = await boot(root);
    try {
      const runRepository = app.get(RunRepository);
      const run = await save(runRepository, 'proj-chk', 'implement', 'waiting');
      run.attemptsChecks = 1;
      await runRepository.saveRun(run);
      const now = new Date().toISOString();
      const stat = await app.get(VisitRepository).finishVisit(run, {
        ...visit('checks', 'waiting'),
        samples: [
          { sampledAt: now, cpuPercent: 10, rssBytes: 100, source: '0' },
          { sampledAt: now, cpuPercent: 20, rssBytes: 200, source: '1' },
        ],
      });
      stat.attemptId = 'att-1';
      await app.get(VisitRepository).saveStat(stat);
      const commands = app.get(CheckCommandRepository);
      const first = await commands.add({
        runId: run.id,
        attemptId: 'att-1',
        repo: 'api',
        command: 'npm test',
        commandIndex: 0,
      });
      await commands.save({ ...first, status: 'passed', exitCode: 0 });
      await commands.add({ runId: run.id, attemptId: 'att-1', repo: 'api', command: 'npm run lint', commandIndex: 1 });
      const runs = app.get(RunQueriesService);
      const detail = await runs.step('proj-chk', 'checks');
      expect(detail.commands?.map((item) => [item.index, item.command, item.status, item.exitCode])).toEqual([
        [0, 'npm test', 'passed', 0],
        [1, 'npm run lint', 'waiting', null],
      ]);
      expect(detail.visits[0]?.samples.map((sample) => sample.source)).toEqual(['0', '1']);
      const flow = await runs.flow('proj-chk');
      expect(flow.returns).toEqual([{ counter: 'checks', count: 1, from: 'checks', to: 'implement' }]);
      expect(flow.metrics.attemptsChecks).toBe(1);
      expect(flow.phases.map((phase) => phase.phase)).toEqual([
        'planning',
        'implementation',
        'checks',
        'code-review',
        'ci',
      ]);
    } finally {
      await app.close();
    }
  });

  it('still shows the checks document a run stored under its implement visit before the checks step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-old-checks-'));
    const app = await boot(root);
    try {
      const run = await save(app.get(RunRepository), 'proj-old', 'code-review', 'waiting');
      await app.get(VisitRepository).finishVisit(run, {
        ...visit('implement', 'done'),
        documents: [{ kind: 'checks', fileName: '', body: '{"repo":"api","command":"npm test","exitCode":0}' }],
      });
      const detail = await app.get(RunQueriesService).step('proj-old', 'implement');
      expect(detail.visits[0]?.documents.map((item) => item.kind)).toContain('checks');
    } finally {
      await app.close();
    }
  });
});
