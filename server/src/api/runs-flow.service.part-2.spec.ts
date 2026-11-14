import 'reflect-metadata';

import { utimesSync } from 'fs';

import { mkdir, mkdtemp, writeFile } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { RunRepository } from '../history/run.repository';

import { VisitRepository } from '../history/visit.repository';

import { RunQueriesService } from './run-queries.service';

import { boot, save, visit } from '../testing/runs.spec-helpers';

describe('runs api', () => {
  it('numbers a reviewer by its own visits, not the shared code-review round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-numbers-'));
    const app = await boot(root);
    try {
      await mkdir(join(root, 'data'), { recursive: true });
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runs, 'proj-26', 'code-review', 'running');
      await visits.finishVisit(run, {
        ...visit('code-review', 'done'),
        documents: [{ kind: 'review_performance', fileName: '', body: 'notes\ndecision: ok\n' }],
      });
      await visits.finishVisit(run, { ...visit('code-review', 'waiting'), documents: [] });
      await visits.finishVisit(run, { ...visit('code-review', 'waiting'), documents: [] });
      await visits.finishVisit(run, { ...visit('code-review', 'waiting'), documents: [] });
      await writeFile(
        join(root, 'data', 'proj-26-code-review-performance-output.txt'),
        `${JSON.stringify({ type: 'thinking', text: 'again' })}\n`,
      );
      await writeFile(join(root, 'data', 'proj-26-code-review-performance-launches.txt'), '1\n1\n');
      const chips =
        (await app.get(RunQueriesService).flow('proj-26')).phases.find((phase) => phase.phase === 'code-review')
          ?.steps ?? [];
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
      const runRepository = app.get(RunRepository);
      const run = await save(runRepository, 'proj-32', 'code-review', 'running');
      // A log counts for the open round only when its file is newer than the round start. The kernel stamps files with a coarser clock than the one that stamped the round, so a log written right after the claim can look older. The round began a minute ago.
      run.stepStartedAt = new Date(Date.now() - 60_000).toISOString();
      await runRepository.saveRun(run);
      await writeFile(
        join(root, 'data', 'proj-32-code-review-regressions-output.txt'),
        'thinking\nprocess killed: time\nthinking\n',
      );
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
      await save(runRepository, 'proj-33', 'research', 'running');
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
      await save(app.get(RunRepository), 'proj-29', 'code-review', 'running');
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
      await writeFile(
        join(root, 'data', 'proj-29-code-review-requirements-output.txt'),
        'process killed: time\nprocess started\n',
      );
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
      const runRepository = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runRepository, 'proj-round', 'code-review', 'running');
      const round1 = '2026-10-28T10:00:00.000Z';
      const round2 = '2026-10-28T11:00:00.000Z';
      run.stepStartedAt = round1;
      await runRepository.saveRun(run);
      const stored = [
        ['requirements', 'ok', 'done'],
        ['quality', 'return', 'waiting'],
        ['regressions', 'ok', 'done'],
        ['security', 'return', 'waiting'],
        ['performance', 'ok', 'done'],
      ] as const;
      for (const [name, decision, status] of stored) {
        await visits.finishVisit(run, {
          ...visit(`code-review-${name}`, status),
          documents: [{ kind: `review_${name}`, fileName: '', body: `round 1\ndecision: ${decision}\n` }],
        });
      }
      run.stepStartedAt = round2;
      await runRepository.saveRun(run);
      const file = (name: string) => join(root, 'data', `proj-round-code-review-${name}-output.txt`);
      await writeFile(file('quality'), 'notes\ndecision: ok\nprocess exited 0\n');
      const older = new Date(Date.parse(round2) - 60_000);
      utimesSync(file('quality'), older, older);
      await writeFile(file('requirements'), 'notes\ndecision: ok\nprocess exited 0\n');
      await writeFile(file('regressions'), 'thinking\n');
      await writeFile(file('performance'), 'notes\ndecision: return\nprocess exited 0\n');
      await writeFile(file('security'), 'starting\n');
      const runs = app.get(RunQueriesService);
      const chips = async () =>
        (await runs.flow('proj-round')).phases.find((phase) => phase.phase === 'code-review')?.steps ?? [];
      const running = await chips();
      const at = (steps: { name: string; status: string; attempts: number }[], name: string) =>
        steps.find((step) => step.name === name);
      expect(at(running, 'code-review-requirements')?.attempts).toBe(2);
      expect(at(running, 'code-review-requirements')?.status).toBe('done');
      expect(at(running, 'code-review-regressions')?.attempts).toBe(2);
      expect(at(running, 'code-review-regressions')?.status).toBe('running');
      expect(at(running, 'code-review-performance')?.attempts).toBe(2);
      expect(at(running, 'code-review-performance')?.status).toBe('returned');
      expect(at(running, 'code-review-quality')?.attempts).toBe(1);
      expect(at(running, 'code-review-quality')?.status).toBe('running');
      expect(at(running, 'code-review-security')?.attempts).toBe(1);
      expect(at(running, 'code-review-security')?.status).toBe('running');

      run.status = 'waiting';
      await runRepository.saveRun(run);
      const held = await chips();
      expect(at(held, 'code-review-requirements')?.attempts).toBe(1);
      expect(at(held, 'code-review-requirements')?.status).toBe('done');
      expect(at(held, 'code-review-quality')?.attempts).toBe(1);
      expect(at(held, 'code-review-quality')?.status).toBe('returned');
      expect(at(held, 'code-review-regressions')?.attempts).toBe(1);
      expect(at(held, 'code-review-regressions')?.status).toBe('done');
      expect(at(held, 'code-review-security')?.attempts).toBe(1);
      expect(at(held, 'code-review-security')?.status).toBe('returned');
      expect(at(held, 'code-review-performance')?.attempts).toBe(1);
      expect(at(held, 'code-review-performance')?.status).toBe('done');
      expect(at(held, 'code-review')?.status).toBe('returned');

      run.status = 'running';
      run.currentStep = 'code-review';
      run.stepStartedAt = round2;
      await runRepository.saveRun(run);
      const next = [
        ['requirements', 'return', 'waiting'],
        ['quality', 'ok', 'done'],
        ['regressions', 'return', 'waiting'],
        ['security', 'ok', 'done'],
        ['performance', 'ok', 'done'],
      ] as const;
      for (const [name, decision, status] of next) {
        await visits.finishVisit(run, {
          ...visit(`code-review-${name}`, status),
          documents: [{ kind: `review_${name}`, fileName: '', body: `round 2\ndecision: ${decision}\n` }],
        });
      }
      await writeFile(join(root, 'data', 'proj-round-code-review-report-output.txt'), 'thinking\n');
      const saved = await chips();
      expect(at(saved, 'code-review-requirements')?.attempts).toBe(2);
      expect(at(saved, 'code-review-requirements')?.status).toBe('returned');
      expect(at(saved, 'code-review-quality')?.attempts).toBe(2);
      expect(at(saved, 'code-review-quality')?.status).toBe('done');
      expect(at(saved, 'code-review-regressions')?.attempts).toBe(2);
      expect(at(saved, 'code-review-regressions')?.status).toBe('returned');
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
      const runRepository = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runRepository, 'proj-kill', 'code-review', 'running');
      run.stepStartedAt = '2026-10-28T10:00:00.000Z';
      await runRepository.saveRun(run);
      await visits.finishVisit(run, {
        ...visit('code-review-requirements', 'done'),
        documents: [{ kind: 'review_requirements', fileName: '', body: 'round 1\ndecision: ok\n' }],
      });
      run.stepStartedAt = '2026-10-28T11:00:00.000Z';
      await runRepository.saveRun(run);
      const path = join(root, 'data', 'proj-kill-code-review-requirements-output.txt');
      await writeFile(path, 'thinking\nprocess killed: time\n');
      const runs = app.get(RunQueriesService);
      const chip = async () =>
        (await runs.flow('proj-kill')).phases
          .flatMap((phase) => phase.steps)
          .find((step) => step.name === 'code-review-requirements');
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
      await save(app.get(RunRepository), 'proj-23', 'code-review', 'failed');
      const chips =
        (await app.get(RunQueriesService).flow('proj-23')).phases.find((phase) => phase.phase === 'code-review')
          ?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review-quality')?.status).toBe('returned');
    } finally {
      await app.close();
    }
  });

  it('does not paste the step error onto a reviewer that already decided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-review-error-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runs, 'proj-24', 'code-review', 'failed');
      await visits.finishVisit(run, {
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
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await runs.begin('proj-duration', 'implement');
      run.stepStartedAt = '2026-10-28T10:00:00.000Z';
      await visits.finishVisit(run, { ...visit('implement', 'done'), durationMs: 1_000 });
      run.stepStartedAt = '2026-10-28T10:01:00.000Z';
      await visits.finishVisit(run, { ...visit('code-review-quality', 'done'), durationMs: 8_000 });
      await visits.finishVisit(run, { ...visit('code-review-security', 'done'), durationMs: 3_000 });
      await visits.finishVisit(run, {
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
      await runs.saveRun(run);
      const short = await runs.begin('proj-duration-short', 'code-review');
      short.stepStartedAt = '2026-10-28T11:00:00.000Z';
      await visits.finishVisit(short, { ...visit('code-review-quality', 'done'), durationMs: 8_000 });
      await visits.finishVisit(short, {
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
      await runs.saveRun(short);
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
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await runs.begin('proj-loop', 'code-review');
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
      await visits.finishVisit(run, {
        ...visit('code-review-quality', 'done'),
        durationMs: 3_000,
        startedAt: '2026-10-28T10:00:01.000Z',
        finishedAt: '2026-10-28T10:00:04.000Z',
      });
      await visits.finishVisit(run, {
        ...visit('code-review', 'waiting'),
        durationMs: 5_000,
        startedAt: '2026-10-28T10:00:00.000Z',
        finishedAt: '2026-10-28T10:00:05.000Z',
        exchange: report('2026-10-28T10:00:04.000Z', '2026-10-28T10:00:05.000Z', 1_000),
      });
      await visits.finishVisit(run, {
        ...visit('implement', 'done'),
        durationMs: 4_000,
        startedAt: '2026-10-28T10:10:00.000Z',
        finishedAt: '2026-10-28T10:10:04.000Z',
      });
      await visits.finishVisit(run, {
        ...visit('code-review-quality', 'done'),
        durationMs: 4_000,
        startedAt: '2026-10-28T10:20:01.000Z',
        finishedAt: '2026-10-28T10:20:05.000Z',
      });
      await visits.finishVisit(run, {
        ...visit('code-review-security', 'done'),
        durationMs: 9_000,
        startedAt: '2026-10-28T10:20:01.000Z',
        finishedAt: '2026-10-28T10:20:10.000Z',
      });
      await visits.finishVisit(run, {
        ...visit('code-review', 'done'),
        durationMs: 12_000,
        startedAt: '2026-10-28T10:20:00.000Z',
        finishedAt: '2026-10-28T10:20:12.000Z',
        exchange: report('2026-10-28T10:20:10.000Z', '2026-10-28T10:20:12.000Z', 2_000),
      });
      run.status = 'done';
      run.currentStep = 'done';
      run.ownerPid = null;
      await runs.saveRun(run);
      const listed = await app.get(RunQueriesService).list();
      const flow = await app.get(RunQueriesService).flow('proj-loop');
      expect(listed.runs.find((item) => item.key === 'proj-loop')?.durationMs).toBe(21_000);
      expect(flow.metrics.durationMs).toBe(21_000);
    } finally {
      await app.close();
    }
  });
});
