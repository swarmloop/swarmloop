import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { Repository } from 'typeorm';
import { DenyPathEntity } from '../history/entities';
import { SwarmloopConfigModule } from '../config/config.module';
import { HistoryModule } from '../history/history.module';
import { HistoryService } from '../history/history.service';
import { LiveHub } from '../live/live.hub';
import { LiveModule } from '../live/live.module';
import { VisitDraft } from '../history/visit';
import { PHASES } from '../pipeline/pipeline-result';
import { PipelineService } from '../pipeline/pipeline.service';
import { PrepareService } from '../steps/prepare/prepare.service';
import { ProjectAppendService } from '../steps/prepare/project-append.service';
import { REBASE_MERGE_SKIP } from '../steps/merge-request/merge-request.service';
import { REBASE_CONFLICT } from '../steps/rebase-worktree';
import { RunsService } from './runs.service';

describe('runs api', () => {
  it('lists runs newest first and draws a return edge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      await save(history, 'alpha', 'prepare', 'waiting');
      const second = await save(history, 'beta', 'implement', 'waiting', 2);
      await save(history, 'alpha', 'prepare', 'waiting');
      const listed = await app.get(RunsService).list();
      expect(listed.runs.map((run) => run.key)).toEqual(['beta', 'alpha']);
      const flow = await app.get(RunsService).flow('beta');
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.current)?.name).toBe('implement');
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'prepare')?.status).toBe('done');
      expect(flow.sentence).toBe('The next continuation returns to implementation.');
      expect(flow.returns).toEqual([{ counter: 'review', count: 2, from: 'code-review', to: 'implement' }]);
      expect(second.attemptsReview).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('names a run from the first line of the prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-name-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const runs = app.get(RunsService);
      const long = `${'a'.repeat(120)}bc`;
      const named = await save(history, 'named', 'prepare', 'waiting');
      named.prompt = 'Ship the field\nmore than the first line';
      await history.saveRun(named);
      const cut = await save(history, 'cut', 'prepare', 'waiting');
      cut.prompt = `${long}\nrest`;
      await history.saveRun(cut);
      const blank = await save(history, 'blank', 'prepare', 'waiting');
      blank.prompt = '  \n';
      await history.saveRun(blank);
      const listed = await runs.list();
      const byKey = Object.fromEntries(listed.runs.map((run) => [run.key, run.name]));
      expect(byKey.named).toBe('Ship the field');
      expect(byKey.cut).toBe('a'.repeat(120));
      expect(byKey.blank).toBe('blank');
      expect((await runs.flow('named')).name).toBe(byKey.named);
      expect((await runs.flow('cut')).name).toBe(byKey.cut);
      expect((await runs.flow('blank')).name).toBe(byKey.blank);
    } finally {
      await app.close();
    }
  });

  it('stores answers and then allows resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-answers-'));
    let claimed = false;
    const pipeline = {
      startDetached: jest.fn(async () => {
        claimed = true;
        return { exitCode: 0, message: 'proj-3 started' };
      }),
      claimed: () => claimed,
    };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-3', 'research', 'waiting');
      await history.putDocument(run, 'questions', '- which limit\n');
      const runs = app.get(RunsService);
      await expect(runs.resume('proj-3')).rejects.toBeInstanceOf(BadRequestException);
      const answered = await runs.answers('proj-3', { answers: [{ kind: 'question', id: 'which limit', body: 'three' }] });
      expect(answered.resume).toBe('running');
      expect(await history.latestBody('proj-3', 'answers')).toContain('answer: three');
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-3');
    } finally {
      await app.close();
    }
  });

  it('starts a single code reviewer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-reviewer-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }), claimed: () => false };
    const app = await boot(root, pipeline);
    try {
      await save(app.get(HistoryService), 'proj-reviewer', 'code-review', 'waiting');
      await app.get(RunsService).startStep('proj-reviewer', 'code-review-quality');
      expect(pipeline.startDetached).toHaveBeenCalledWith(
        'proj-reviewer',
        { prompt: undefined, path: undefined, reviewer: 'quality' },
        'code-review',
      );
    } finally {
      await app.close();
    }
  });

  it('replays a chosen step with the new prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-replay-'));
    const pipeline = { startDetached: jest.fn(), replay: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-11 started' }) };
    const app = await boot(root, pipeline);
    try {
      await save(app.get(HistoryService), 'proj-11', 'implement-improve', 'failed');
      const result = await app.get(RunsService).replay('proj-11', 'implement', 'Use the other parser');
      expect(result).toEqual({ http: 202, body: { key: 'proj-11', status: 'started' } });
      expect(pipeline.replay).toHaveBeenCalledWith('proj-11', 'implement', 'Use the other parser');
    } finally {
      await app.close();
    }
  });

  it('keeps the original phase list and records a different replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-phases-'));
    const pipeline = {
      startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }),
      replay: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }),
    };
    const app = await boot(root, pipeline);
    try {
      const runs = app.get(RunsService);
      const history = app.get(HistoryService);
      await runs.start({ key: 'proj-12', prompt: 'Review the checkout', phases: ['requirements', 'code-review'], projects: ['demo'] });
      await runs.replay('proj-12', 'code-review', 'Skip the pipeline', ['requirements', 'code-review', 'ci']);
      const run = await history.findRun('proj-12');
      const rows = await history.listFlows(run?.id ?? 0);
      expect(rows.map((row) => ({ phases: JSON.parse(row.phases) as string[], fromStep: row.fromStep }))).toEqual([
        { phases: ['requirements', 'code-review'], fromStep: null },
        { phases: ['requirements', 'code-review', 'ci'], fromStep: 'code-review' },
      ]);
      await expect(runs.start({ key: 'proj-13', prompt: 'Nope', phases: ['nope'] })).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      await app.close();
    }
  });

  it('stops a running step without starting it again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-stop-'));
    const pipeline = { startDetached: jest.fn(), stop: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-9 stopped' }) };
    const app = await boot(root, pipeline);
    try {
      await save(app.get(HistoryService), 'proj-9', 'implement-improve', 'running');
      const result = await app.get(RunsService).stop('proj-9');
      expect(result).toEqual({ http: 200, body: { key: 'proj-9', status: 'stopped' } });
      expect(pipeline.stop).toHaveBeenCalledWith('proj-9');
      expect(pipeline.startDetached).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not resume a blocked prepare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-blocked-'));
    const app = await boot(root);
    try {
      await save(app.get(HistoryService), 'proj-4', 'prepare', 'blocked');
      await expect(app.get(RunsService).resume('proj-4')).rejects.toBeInstanceOf(ConflictException);
    } finally {
      await app.close();
    }
  });

  it('resumes a blocked looping step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-loop-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }), claimed: () => false };
    const app = await boot(root, pipeline);
    try {
      await save(app.get(HistoryService), 'proj-loop', 'code-review', 'blocked');
      const flow = await app.get(RunsService).flow('proj-loop');
      expect(flow.resume).toBe('ready');
      await app.get(RunsService).resume('proj-loop');
      expect(pipeline.startDetached).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('resumes a blocked code-review that did not fit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-fit-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }), claimed: () => false };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-fit', 'code-review', 'blocked');
      await history.putDocument(run, 'error', 'code-review does not fit\n');
      const flow = await app.get(RunsService).flow('proj-fit');
      expect(flow.resume).toBe('ready');
      expect(flow.sentence).toContain('agent-call budget');
      await app.get(RunsService).resume('proj-fit');
      expect(pipeline.startDetached).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not ask old questions on a later step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-later-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-6', 'commit', 'waiting');
      await history.putDocument(run, 'questions', '- which limit\n');
      await history.finishVisit(run, visit('requirements', 'waiting'));
      const flow = await app.get(RunsService).flow('proj-6');
      expect(flow.items).toEqual([]);
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'requirements')?.status).toBe('done');
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'requirements')?.attempts).toBe(0);
      expect(flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'prepare')?.attempts).toBe(0);
      await mkdir(join(root, 'data'), { recursive: true });
      await writeFile(join(root, 'data', 'proj-6-requirements-launches.txt'), '1\n1\n');
      const recorded = await app.get(RunsService).flow('proj-6');
      expect(recorded.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'requirements')?.attempts).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('keeps the prompt when a checkout starts code review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-path-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-7 started' }) };
    const app = await boot(root, pipeline);
    try {
      const started = await app.get(RunsService).start({ key: 'proj-7', prompt: 'Look here', path: '/tmp/checkout' });
      expect(started.http).toBe(202);
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-7', { path: '/tmp/checkout', phases: [...PHASES] }, 'code-review');
      expect((await app.get(HistoryService).findRun('proj-7'))?.prompt).toBe('Look here');
    } finally {
      await app.close();
    }
  });

  it('opens the next session even when an earlier one is still running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-parked-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      const previous = await save(history, 'PROJ-12', 'code-review', 'failed');
      previous.prompt = 'old brief\n';
      await history.saveRun(previous);
      await save(history, 'PROJ-12--2', 'done', 'done');
      const live = await save(history, 'PROJ-12--3', 'code-review', 'running');
      live.ownerPid = process.pid;
      await history.saveRun(live);
      const prompt = 'https://example.atlassian.net/browse/PROJ-12\nbranch: feature/PROJ-12-add-export';
      const started = await app.get(RunsService).start({
        prompt,
        phases: ['requirements', 'code-review'],
        projects: ['billing-api'],
      });
      expect(started.http).toBe(202);
      expect(started.body.key).toBe('PROJ-12--4');
      expect(pipeline.startDetached).toHaveBeenCalledWith('PROJ-12--4', {
        prompt,
        projects: ['billing-api'],
        phases: ['requirements', 'code-review'],
      });
      expect((await history.findRun('PROJ-12'))?.prompt).toBe('old brief\n');
      expect((await history.findRun('PROJ-12--3'))?.status).toBe('running');
    } finally {
      await app.close();
    }
  });

  it('opens a new session when the ticket run is done', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-session-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }) };
    const app = await boot(root, pipeline);
    try {
      await save(app.get(HistoryService), 'PROJ-12', 'done', 'done');
      const prompt = 'https://example.atlassian.net/browse/PROJ-12\nbranch: feature/PROJ-12-add-export';
      const started = await app.get(RunsService).start({
        prompt,
        phases: ['requirements', 'code-review'],
        projects: ['billing-api'],
      });
      expect(started.http).toBe(202);
      expect(started.body.key).toBe('PROJ-12--2');
      expect(pipeline.startDetached).toHaveBeenCalledWith('PROJ-12--2', {
        prompt,
        projects: ['billing-api'],
        phases: ['requirements', 'code-review'],
      });
      expect((await app.get(HistoryService).findRun('PROJ-12'))?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('uses a ticket key from the prompt when no run id is sent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-ticket-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }) };
    const app = await boot(root, pipeline);
    try {
      const started = await app.get(RunsService).start({ prompt: 'Ship PROJ-15 before Friday', projects: ['demo'] });
      expect(started.http).toBe(202);
      expect(started.body.key).toBe('PROJ-15');
      expect(pipeline.startDetached).toHaveBeenCalledWith('PROJ-15', { prompt: 'Ship PROJ-15 before Friday', projects: ['demo'], phases: [...PHASES] });
    } finally {
      await app.close();
    }
  });

  it('assigns a run id when the prompt has no ticket key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-slug-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }) };
    const app = await boot(root, pipeline);
    try {
      const started = await app.get(RunsService).start({ prompt: 'Ship the field', projects: ['demo'] });
      expect(started.body.key).toMatch(/^run-[a-z0-9]+$/);
      expect(pipeline.startDetached).toHaveBeenCalledWith(started.body.key, { prompt: 'Ship the field', projects: ['demo'], phases: [...PHASES] });
    } finally {
      await app.close();
    }
  });

  it('does not ask for a clone while prepare is waiting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-clones-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'proj-9', 'prepare', 'waiting');
      await history.finishVisit(run, visit('prepare', 'waiting'));
      const flow = await app.get(RunsService).flow('proj-9');
      expect(flow.sentence).toBe('The next continuation prepares the worktrees.');
      expect(flow.items).toEqual([]);
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
      const flow = await app.get(RunsService).flow('proj-9');
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
      const flow = await app.get(RunsService).flow('proj-pipe-red');
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
      const flow = await app.get(RunsService).flow('proj-review-red');
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
      const flow = await app.get(RunsService).flow('proj-pipe-green');
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
      const flow = await app.get(RunsService).flow('proj-pipe-run');
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
      expect((await app.get(RunsService).flow('proj-8')).reason).toBe('checkouts is empty');
    } finally {
      await app.close();
    }
  });

  it('starts a new run in the background', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-start-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-5 started' }) };
    const app = await boot(root, pipeline);
    try {
      const started = await app.get(RunsService).start({ key: 'proj-5', prompt: 'Ship the field', projects: ['demo'] });
      expect(started.http).toBe(202);
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-5', { prompt: 'Ship the field', projects: ['demo'], phases: [...PHASES] });
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
      const runs = app.get(RunsService);
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
      const runs = app.get(RunsService);
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
      const step = await app.get(RunsService).step('proj-21', 'implement');
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
      const runs = app.get(RunsService);
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
      const runs = app.get(RunsService);
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
      const runs = app.get(RunsService);
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
      const quality = await app.get(RunsService).step('proj-31', 'code-review-quality');
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
      const chips = (await app.get(RunsService).flow('proj-22')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
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
      const chips = (await app.get(RunsService).flow('proj-25')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review-quality')?.attempts).toBe(1);
      const quality = await app.get(RunsService).step('proj-25', 'code-review-quality');
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
      const detail = await app.get(RunsService).step('proj-27', 'code-review');
      expect(detail.visits.map((item) => [item.attempt, item.status, item.decision])).toEqual([
        [1, 'waiting', 'decision: return'],
        [2, 'done', 'decision: ok'],
      ]);
      const chips = (await app.get(RunsService).flow('proj-27')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
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
      const chips = (await app.get(RunsService).flow('proj-26')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
      expect(chips.find((step) => step.name === 'code-review-performance')?.attempts).toBe(2);
      const performance = await app.get(RunsService).step('proj-26', 'code-review-performance');
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
      const runs = app.get(RunsService);
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
      const steps = (await app.get(RunsService).flow('proj-29')).phases.flatMap((phase) => phase.steps);
      expect(steps.find((step) => step.name === 'code-review-requirements')?.attempts).toBe(1);
      expect(steps.find((step) => step.name === 'code-review-requirements')?.status).toBe('running');
      const detail = await app.get(RunsService).step('proj-29', 'code-review-requirements');
      expect(detail.visits.at(-1)?.status).toBe('running');
      expect(detail.visits.map((item) => item.attempt)).toEqual([1]);
      await writeFile(join(root, 'data', 'proj-29-code-review-requirements-output.txt'), 'process killed: time\n');
      await writeFile(join(root, 'data', 'proj-29-code-review-requirements-launches.txt'), '1\n1\n');
      const killed = (await app.get(RunsService).flow('proj-29')).phases.flatMap((phase) => phase.steps);
      expect(killed.find((step) => step.name === 'code-review-requirements')?.attempts).toBe(1);
      expect(killed.find((step) => step.name === 'code-review-requirements')?.status).toBe('failed');
      await writeFile(join(root, 'data', 'proj-29-code-review-requirements-output.txt'), 'process killed: time\nprocess started\n');
      const again = (await app.get(RunsService).flow('proj-29')).phases.flatMap((phase) => phase.steps);
      expect(again.find((step) => step.name === 'code-review-requirements')?.status).toBe('running');
      await writeFile(
        join(root, 'data', 'proj-29-code-review-requirements-output.txt'),
        'notes\ndecision: ok\nprocess exited 0\n',
      );
      await writeFile(join(root, 'data', 'proj-29-code-review-requirements-launches.txt'), '1\n1\n1\n');
      const decided = (await app.get(RunsService).flow('proj-29')).phases.flatMap((phase) => phase.steps);
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
      const runs = app.get(RunsService);
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
      const runs = app.get(RunsService);
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
      const chips = (await app.get(RunsService).flow('proj-23')).phases.find((phase) => phase.phase === 'code review')?.steps ?? [];
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
        (await app.get(RunsService).step('proj-24', 'code-review-quality')).visits
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
      const listed = await app.get(RunsService).list();
      const flow = await app.get(RunsService).flow('proj-duration');
      const shortFlow = await app.get(RunsService).flow('proj-duration-short');
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
      const listed = await app.get(RunsService).list();
      const flow = await app.get(RunsService).flow('proj-loop');
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
      const flow = await app.get(RunsService).flow('proj-clock');
      expect(flow.stepStartedAt).toBe(started);
      expect(flow.status).toBe('running');
      expect(flow.metrics.durationMs).toBe(5_000);
      expect(flow.metrics.closedStarts).toEqual([started]);
      expect(flow.metrics.cpuPeak).toBe(80);
      expect(flow.metrics.memPeak).toBe(4096);
      run.stepStartedAt = null;
      await history.saveRun(run);
      await history.finishVisit(run, { ...visit('research', 'failed'), durationMs: 4 });
      const later = await app.get(RunsService).flow('proj-clock');
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

  it('rebases a failed implement run and continues that checklist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-failed-'));
    const { tree, clone } = featureWorktree(root, 'proj-50');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'field']);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-50 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      await remember(history, 'proj-50', 'implement', 'failed');
      const result = await app.get(RunsService).rebase('proj-50');
      expect(result).toEqual({ http: 202, body: { key: 'proj-50', status: 'started' } });
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-50');
      const fresh = await history.findRun('proj-50');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('implement');
      expect(await history.latestBody('proj-50', REBASE_MERGE_SKIP)).toBeNull();
      git(tree, ['merge-base', '--is-ancestor', base, 'HEAD']);
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-50-ship-the-field');
      expect(git(tree, ['log', '--oneline'])).toContain('field');
    } finally {
      await app.close();
    }
  });

  it('rebases a done run and starts code review with ci', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-done-'));
    const { tree, clone } = featureWorktree(root, 'proj-51');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'field']);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['branch', 'release']);
    git(clone, ['push', 'origin', 'release']);
    const release = git(clone, ['rev-parse', 'release']);
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-51 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-51', 'done', 'done');
      run.prompt = 'branch: release\n';
      await history.saveRun(run);
      await history.putDocument(run, 'implementation', '- changed the field\n');
      const branch = 'feature/proj-51-ship-the-field';
      git(tree, ['push', '-u', 'origin', branch]);
      const tip = git(tree, ['rev-parse', `refs/remotes/origin/${branch}`]);
      const result = await app.get(RunsService).rebase('proj-51');
      expect(result).toEqual({ http: 202, body: { key: 'proj-51', status: 'started' } });
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-51');
      const fresh = await history.findRun('proj-51');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('code-review');
      expect((await history.latestBody('proj-51', REBASE_MERGE_SKIP))?.trim()).toBe('skip');
      const rows = await history.listFlows(fresh?.id ?? 0);
      expect(JSON.parse(rows.at(-1)?.phases ?? '[]')).toEqual(['requirements', 'code-review', 'ci']);
      expect(rows.at(-1)?.fromStep).toBe('code-review');
      git(tree, ['merge-base', '--is-ancestor', release, 'HEAD']);
      expect(git(tree, ['log', '--oneline'])).toContain('field');
      expect(git(tree, ['rev-parse', `refs/remotes/origin/${branch}`])).toBe(tip);
      expect(git(tree, ['rev-parse', 'HEAD'])).not.toBe(tip);
      expect(git(tree, ['branch', '--show-current'])).toBe(branch);
    } finally {
      await app.close();
    }
  });

  it('commits allowed dirt before rebase and leaves .env unstaged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-commit-'));
    const { tree, clone } = featureWorktree(root, 'proj-52');
    writeFileSync(join(tree, 'src', 'dirty.ts'), 'export const dirty = 1;\n');
    writeFileSync(join(tree, '.env'), 'TOKEN=secret\n');
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-52 started' }) };
    const app = await boot(root, pipeline);
    try {
      await denyEnv(app);
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-52', 'done', 'done');
      await history.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunsService).rebase('proj-52');
      expect(result).toEqual({ http: 202, body: { key: 'proj-52', status: 'started' } });
      const names = git(tree, ['show', '--name-only', '--format=', 'HEAD']);
      expect(names).toContain('src/dirty.ts');
      expect(names).not.toContain('.env');
      expect(git(tree, ['status', '--porcelain'])).toContain('.env');
      git(tree, ['merge-base', '--is-ancestor', base, 'HEAD']);
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-52-ship-the-field');
      expect((await history.findRun('proj-52'))?.currentStep).toBe('code-review');
    } finally {
      await app.close();
    }
  });

  it('leaves a done run unchanged when only a denied path is dirty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-denied-'));
    const { tree } = featureWorktree(root, 'proj-53');
    writeFileSync(join(tree, '.env'), 'TOKEN=1\n');
    git(tree, ['add', '.env']);
    git(tree, ['commit', '-m', 'env']);
    writeFileSync(join(tree, '.env'), 'TOKEN=2\n');
    const head = git(tree, ['rev-parse', 'HEAD']);
    const pipeline = { startDetached: jest.fn() };
    const app = await boot(root, pipeline);
    try {
      await denyEnv(app);
      const history = app.get(HistoryService);
      await remember(history, 'proj-53', 'done', 'done');
      await expect(app.get(RunsService).rebase('proj-53')).rejects.toThrow('demo rebase failed');
      const fresh = await history.findRun('proj-53');
      expect(fresh?.status).toBe('done');
      expect(fresh?.currentStep).toBe('done');
      expect(git(tree, ['rev-parse', 'HEAD'])).toBe(head);
      expect(git(tree, ['status', '--porcelain'])).toContain('.env');
      expect(pipeline.startDetached).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('sends a done run with no implementation notes to implement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-unfinished-'));
    const { tree } = featureWorktree(root, 'proj-54');
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-54 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      await remember(history, 'proj-54', 'done', 'done');
      await history.noteFlow('proj-54', ['code-review', 'ci'], 'code-review');
      const result = await app.get(RunsService).rebase('proj-54');
      expect(result).toEqual({ http: 202, body: { key: 'proj-54', status: 'started' } });
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-54');
      const fresh = await history.findRun('proj-54');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('implement');
      expect(await history.latestBody('proj-54', REBASE_MERGE_SKIP)).toBeNull();
      const rows = await history.listFlows(fresh?.id ?? 0);
      expect(JSON.parse(rows.at(-1)?.phases ?? '[]')).toEqual(['requirements', 'implementation', 'code-review', 'ci']);
      expect(rows.at(-1)?.fromStep).toBe('implement');
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-54-ship-the-field');
    } finally {
      await app.close();
    }
  });

  it('resumes a finished failed run on its step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-resume-'));
    const { tree } = featureWorktree(root, 'proj-55');
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-55 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-55', 'implement-improve', 'failed');
      await history.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunsService).rebase('proj-55');
      expect(result).toEqual({ http: 202, body: { key: 'proj-55', status: 'started' } });
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-55', {});
      const fresh = await history.findRun('proj-55');
      expect(fresh?.status).toBe('failed');
      expect(fresh?.currentStep).toBe('implement-improve');
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-55-ship-the-field');
    } finally {
      await app.close();
    }
  });

  it('rebases a waiting run and resumes that step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-waiting-'));
    const { tree } = featureWorktree(root, 'proj-58');
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-58 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-58', 'implement-improve', 'waiting');
      await history.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunsService).rebase('proj-58');
      expect(result).toEqual({ http: 202, body: { key: 'proj-58', status: 'started' } });
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-58', {});
      const fresh = await history.findRun('proj-58');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('implement-improve');
      expect(await history.latestBody('proj-58', REBASE_MERGE_SKIP)).toBeNull();
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-58-ship-the-field');
    } finally {
      await app.close();
    }
  });

  it('leaves a conflict in progress and does not skip the merge request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-conflict-'));
    const { tree: demo, clone: demoClone } = featureWorktree(root, 'proj-56', 'demo');
    const { tree: other, clone: otherClone } = featureWorktree(root, 'proj-56', 'other');
    const { tree: later, clone: laterClone } = featureWorktree(root, 'proj-56', 'later');
    writeFileSync(join(demo, 'src', 'field.ts'), 'export const field = 1;\n');
    git(demo, ['add', 'src/field.ts']);
    git(demo, ['commit', '-m', 'field']);
    git(demoClone, ['switch', 'main']);
    writeFileSync(join(demoClone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(demoClone, ['add', 'src/base.ts']);
    git(demoClone, ['commit', '-m', 'base']);
    git(demoClone, ['push', 'origin', 'main']);
    const demoBase = git(demoClone, ['rev-parse', 'main']);
    writeFileSync(join(other, 'src', 'field.ts'), 'export const field = 1;\n');
    git(other, ['add', 'src/field.ts']);
    git(other, ['commit', '-m', 'field']);
    git(otherClone, ['switch', 'main']);
    writeFileSync(join(otherClone, 'src', 'field.ts'), 'export const field = 2;\n');
    git(otherClone, ['add', 'src/field.ts']);
    git(otherClone, ['commit', '-m', 'base']);
    git(otherClone, ['push', 'origin', 'main']);
    writeFileSync(join(later, 'src', 'keep.ts'), 'export const keep = 1;\n');
    git(later, ['add', 'src/keep.ts']);
    git(later, ['commit', '-m', 'keep']);
    git(laterClone, ['switch', 'main']);
    writeFileSync(join(laterClone, 'src', 'next.ts'), 'export const next = 1;\n');
    git(laterClone, ['add', 'src/next.ts']);
    git(laterClone, ['commit', '-m', 'next']);
    git(laterClone, ['push', 'origin', 'main']);
    const laterBase = git(laterClone, ['rev-parse', 'main']);
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-56 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-56', 'code-review', 'failed');
      await history.putDocument(run, 'implementation', '- changed the field\n');
      await history.putDocument(run, 'repos', 'demo\nother\nlater\n');
      const result = await app.get(RunsService).rebase('proj-56');
      expect(result).toEqual({ http: 202, body: { key: 'proj-56', status: 'started' } });
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-56');
      const fresh = await history.findRun('proj-56');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('implement');
      expect((await history.latestBody('proj-56', REBASE_CONFLICT))?.trim()).toBe('pending');
      expect(await history.latestBody('proj-56', REBASE_MERGE_SKIP)).toBeNull();
      expect(isAncestor(demo, demoBase)).toBe(true);
      expect(git(demo, ['branch', '--show-current'])).toBe('feature/proj-56-ship-the-field');
      expect(git(other, ['diff', '--name-only', '--diff-filter=U'])).toContain('src/field.ts');
      expect(git(other, ['branch', '--show-current'])).toBe('');
      expect(isAncestor(later, laterBase)).toBe(false);
      expect(git(later, ['branch', '--show-current'])).toBe('feature/proj-56-ship-the-field');
    } finally {
      await app.close();
    }
  });

  it('rebases onto the fetched remote source when the local tracking ref is stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-remote-'));
    const { tree, clone } = featureWorktree(root, 'proj-57');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'field']);
    git(clone, ['switch', 'main']);
    git(clone, ['switch', '-c', 'release']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'release']);
    const stale = git(tree, ['rev-parse', 'origin/release']);
    const bare = join(root, 'demo.git');
    const other = join(root, 'other');
    git(root, ['clone', bare, other]);
    git(other, ['config', 'user.email', 'dev@example.com']);
    git(other, ['config', 'user.name', 'Dev']);
    git(other, ['switch', '--track', 'origin/release']);
    writeFileSync(join(other, 'src', 'remote.ts'), 'export const remote = 1;\n');
    git(other, ['add', 'src/remote.ts']);
    git(other, ['commit', '-m', 'remote']);
    git(other, ['push', 'origin', 'HEAD:release']);
    const tip = git(bare, ['rev-parse', 'refs/heads/release']);
    expect(tip).not.toBe(stale);
    expect(git(tree, ['rev-parse', 'origin/release'])).toBe(stale);
    git(tree, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/demo.git']);
    const restore = hostFetch(bare, 'token');
    const previousSsh = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = 'false';
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-57 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-57', 'done', 'done');
      run.prompt = 'branch: release\n';
      await history.saveRun(run);
      await history.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunsService).rebase('proj-57');
      expect(result).toEqual({ http: 202, body: { key: 'proj-57', status: 'started' } });
      expect(git(tree, ['rev-parse', 'origin/release'])).toBe(tip);
      expect(isAncestor(tree, tip)).toBe(true);
      expect(git(tree, ['log', '--oneline'])).toContain('field');
    } finally {
      if (previousSsh === undefined) {
        delete process.env.GIT_SSH_COMMAND;
      } else {
        process.env.GIT_SSH_COMMAND = previousSsh;
      }
      restore();
      await app.close();
    }
  });

  it('aborts a rebase that stops with nothing applied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-untracked-'));
    const { tree, clone } = featureWorktree(root, 'proj-59');
    writeFileSync(join(tree, 'src', 'added.ts'), 'export const added = 1;\n');
    git(tree, ['add', 'src/added.ts']);
    git(tree, ['commit', '-m', 'add file']);
    git(tree, ['rm', 'src/added.ts']);
    git(tree, ['commit', '-m', 'drop file']);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    writeFileSync(join(tree, 'src', 'readme.ts'), 'export const readme = 2;\n');
    git(tree, ['stash', 'push', '-m', 'swarmloop-rebase', '--', 'src/readme.ts']);
    expect(git(tree, ['status', '--porcelain'])).toBe('');
    const head = git(tree, ['rev-parse', 'HEAD']);
    const common = git(tree, ['rev-parse', '--git-common-dir']);
    const hooks = join(isAbsolute(common) ? common : join(tree, common), 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'post-checkout'), "#!/bin/sh\nprintf 'export const added = 1;\\n' > src/added.ts\nexit 0\n", { mode: 0o755 });
    const pipeline = { startDetached: jest.fn() };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      await remember(history, 'proj-59', 'done', 'done');
      await expect(app.get(RunsService).rebase('proj-59')).rejects.toThrow(
        /demo rebase failed[\s\S]*error:[\s\S]*Please move or remove them before you merge/,
      );
      expect(pipeline.startDetached).not.toHaveBeenCalled();
      expect(git(tree, ['rev-parse', 'HEAD'])).toBe(head);
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-59-ship-the-field');
      expect(isAncestor(tree, base)).toBe(false);
      for (const name of ['rebase-merge', 'rebase-apply']) {
        const printed = git(tree, ['rev-parse', '--git-path', name]);
        expect(existsSync(isAbsolute(printed) ? printed : join(tree, printed))).toBe(false);
      }
      expect(readFileSync(join(tree, 'src', 'readme.ts'), 'utf8')).toBe('export const readme = 2;\n');
    } finally {
      await app.close();
    }
  });

  it('removes the rows and files of one run and leaves the shared store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-remove-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const run = await save(history, 'PROJ-20', 'plan', 'waiting');
      const now = new Date().toISOString();
      await history.finishVisit(run, {
        ...visit('plan', 'done'),
        samples: [{ sampledAt: now, cpuPercent: 1, rssBytes: 2 }],
        exchange: {
          model: 'grok',
          startedAt: now,
          finishedAt: now,
          durationMs: 1,
          requestText: 'req',
          responseText: 'res',
          chatId: null,
          resumed: false,
          killReason: null,
        },
        httpCalls: [{ provider: 'jira', method: 'GET', url: 'http://jira', statusCode: 200, durationMs: 1, error: null }],
      });
      await history.putDocument(run, 'requirements', 'body\n');
      await history.noteFlow('PROJ-20', ['requirements'], null);
      await history.recordLoop(run, 'review', 1, 'again');
      await history.savePaste('PROJ-20', 'http://paste', 'pasted');
      await history.saveCheckout('demo', join(root, 'demo'));
      await denyEnv(app);
      const kept = await save(history, 'keep', 'plan', 'waiting');
      await history.putDocument(kept, 'requirements', 'stay\n');
      const data = join(root, 'data');
      await mkdir(join(data, 'agent-state', 'PROJ-20'), { recursive: true });
      await mkdir(join(root, 'runs', 'PROJ-20'), { recursive: true });
      await mkdir(join(root, 'worktrees', 'PROJ-20'), { recursive: true });
      await writeFile(join(data, 'PROJ-20-plan-output.txt'), 'out\n');
      await writeFile(join(data, 'PROJ-20-plan-launches.txt'), '1\n');
      await writeFile(join(data, 'PROJ-20-plan-session.json'), '{}\n');
      await writeFile(join(data, 'PROJ-20--2-plan-session.json'), '{}\n');
      await writeFile(join(data, 'price-cache-cursor.json'), '{}\n');
      await writeFile(join(data, 'swarmloop-empty-env'), '');
      await writeFile(join(data, 'agent-state', 'PROJ-20', 'brief.txt'), 'brief\n');
      await writeFile(join(root, 'runs', 'PROJ-20', 'state.json'), '{}\n');
      await writeFile(join(root, 'worktrees', 'PROJ-20', 'keep.txt'), 'keep\n');
      const stats = await history.listStats(run.id);
      const ids = stats.map((stat) => stat.id);
      expect(ids).toHaveLength(1);
      const hub = app.get(LiveHub);
      hub.log({ key: 'PROJ-20', step: 'plan', body: '', usage: { tokensIn: 1, tokensOut: 1, usd: 1 } });
      const seen: string[] = [];
      const off = hub.onChanged((key) => seen.push(key));
      await history.remove(run);
      off();
      expect(seen).toEqual(['PROJ-20']);
      expect(hub.spendOf('PROJ-20')).toBeUndefined();
      expect(await history.findRun('PROJ-20')).toBeNull();
      expect(await history.listDocuments(run.id)).toEqual([]);
      expect(await history.listStats(run.id)).toEqual([]);
      expect(await history.listSamples(ids)).toEqual([]);
      expect(await history.listExchanges(ids)).toEqual([]);
      expect(await history.listHttpCalls(run.id)).toEqual([]);
      expect(await history.listLoops(run.id)).toEqual([]);
      expect(await history.listFlows(run.id)).toEqual([]);
      expect(await history.listPastes('PROJ-20')).toEqual([]);
      expect(await history.findRun('keep')).not.toBeNull();
      expect(await history.listDocuments(kept.id)).toHaveLength(1);
      expect((await history.listCheckouts()).map((row) => row.name)).toEqual(['demo']);
      expect(await history.listDenyPaths()).toEqual(['.env']);
      expect(existsSync(join(data, 'PROJ-20-plan-output.txt'))).toBe(false);
      expect(existsSync(join(data, 'PROJ-20-plan-launches.txt'))).toBe(false);
      expect(existsSync(join(data, 'PROJ-20-plan-session.json'))).toBe(false);
      expect(existsSync(join(data, 'agent-state', 'PROJ-20'))).toBe(false);
      expect(existsSync(join(root, 'runs', 'PROJ-20'))).toBe(false);
      expect(existsSync(join(data, 'PROJ-20--2-plan-session.json'))).toBe(true);
      expect(existsSync(join(data, 'price-cache-cursor.json'))).toBe(true);
      expect(existsSync(join(data, 'swarmloop-empty-env'))).toBe(true);
      expect(existsSync(join(data, 'swarmloop.sqlite'))).toBe(true);
      expect(existsSync(join(root, 'worktrees', 'PROJ-20', 'keep.txt'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('leaves a longer run id and the shared data names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-remove-prefix-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const duration = await save(history, 'proj-duration', 'plan', 'waiting');
      await save(history, 'proj-duration-short', 'plan', 'waiting');
      const agent = await save(history, 'agent', 'plan', 'waiting');
      const price = await save(history, 'price', 'plan', 'waiting');
      const loop = await save(history, 'swarmloop', 'plan', 'waiting');
      const data = join(root, 'data');
      await mkdir(join(data, 'agent-state', 'marker'), { recursive: true });
      await writeFile(join(data, 'agent-state', 'marker', 'keep.txt'), 'keep\n');
      await writeFile(join(data, 'proj-duration-plan-output.txt'), 'out\n');
      await writeFile(join(data, 'proj-duration-plan-launches.txt'), '1\n');
      await writeFile(join(data, 'proj-duration-plan-session.json'), '{}\n');
      await writeFile(join(data, 'proj-duration-short-plan-output.txt'), 'out\n');
      await writeFile(join(data, 'proj-duration-short-plan-launches.txt'), '1\n');
      await writeFile(join(data, 'proj-duration-short-plan-session.json'), '{}\n');
      await writeFile(join(data, 'agent-plan-output.txt'), 'out\n');
      await writeFile(join(data, 'price-cache-cursor.json'), '{}\n');
      await writeFile(join(data, 'swarmloop-empty-env'), '');
      await history.remove(duration);
      await history.remove(agent);
      await history.remove(price);
      await history.remove(loop);
      expect(existsSync(join(data, 'proj-duration-plan-output.txt'))).toBe(false);
      expect(existsSync(join(data, 'proj-duration-plan-launches.txt'))).toBe(false);
      expect(existsSync(join(data, 'proj-duration-plan-session.json'))).toBe(false);
      expect(existsSync(join(data, 'agent-plan-output.txt'))).toBe(false);
      expect(existsSync(join(data, 'proj-duration-short-plan-output.txt'))).toBe(true);
      expect(existsSync(join(data, 'proj-duration-short-plan-launches.txt'))).toBe(true);
      expect(existsSync(join(data, 'proj-duration-short-plan-session.json'))).toBe(true);
      expect(existsSync(join(data, 'agent-state', 'marker', 'keep.txt'))).toBe(true);
      expect(existsSync(join(data, 'price-cache-cursor.json'))).toBe(true);
      expect(existsSync(join(data, 'swarmloop-empty-env'))).toBe(true);
      expect(await history.findRun('proj-duration-short')).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('keeps each run step file when the other id is that step name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-remove-step-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const ship = await save(history, 'ship', 'plan', 'waiting');
      await save(history, 'ship-plan', 'plan', 'waiting');
      const plan = await save(history, 'proj-plan', 'plan', 'waiting');
      await save(history, 'proj', 'plan', 'waiting');
      const data = join(root, 'data');
      await writeFile(join(data, 'ship-plan-output.txt'), 'out\n');
      await writeFile(join(data, 'ship-plan-launches.txt'), '1\n');
      await writeFile(join(data, 'ship-plan-session.json'), '{}\n');
      await writeFile(join(data, 'ship-plan-improve-output.txt'), 'out\n');
      await writeFile(join(data, 'ship-plan-plan-output.txt'), 'out\n');
      await writeFile(join(data, 'ship-plan-plan-launches.txt'), '1\n');
      await writeFile(join(data, 'ship-plan-plan-session.json'), '{}\n');
      await writeFile(join(data, 'proj-plan-output.txt'), 'out\n');
      await writeFile(join(data, 'proj-plan-launches.txt'), '1\n');
      await writeFile(join(data, 'proj-plan-session.json'), '{}\n');
      await writeFile(join(data, 'proj-plan-plan-output.txt'), 'out\n');
      await writeFile(join(data, 'proj-plan-plan-launches.txt'), '1\n');
      await writeFile(join(data, 'proj-plan-plan-session.json'), '{}\n');
      await history.remove(ship);
      await history.remove(plan);
      expect(existsSync(join(data, 'ship-plan-output.txt'))).toBe(false);
      expect(existsSync(join(data, 'ship-plan-launches.txt'))).toBe(false);
      expect(existsSync(join(data, 'ship-plan-session.json'))).toBe(false);
      expect(existsSync(join(data, 'ship-plan-improve-output.txt'))).toBe(false);
      expect(existsSync(join(data, 'ship-plan-plan-output.txt'))).toBe(true);
      expect(existsSync(join(data, 'ship-plan-plan-launches.txt'))).toBe(true);
      expect(existsSync(join(data, 'ship-plan-plan-session.json'))).toBe(true);
      expect(existsSync(join(data, 'proj-plan-output.txt'))).toBe(true);
      expect(existsSync(join(data, 'proj-plan-launches.txt'))).toBe(true);
      expect(existsSync(join(data, 'proj-plan-session.json'))).toBe(true);
      expect(existsSync(join(data, 'proj-plan-plan-output.txt'))).toBe(false);
      expect(existsSync(join(data, 'proj-plan-plan-launches.txt'))).toBe(false);
      expect(existsSync(join(data, 'proj-plan-plan-session.json'))).toBe(false);
      expect(await history.findRun('ship')).toBeNull();
      expect(await history.findRun('ship-plan')).not.toBeNull();
      expect(await history.findRun('proj')).not.toBeNull();
      expect(await history.findRun('proj-plan')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('keeps a requirements review file when the other id is that code-review prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-remove-review-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const proj = await save(history, 'proj', 'code-review', 'waiting');
      const review = await save(history, 'proj-code-review', 'requirements', 'waiting');
      const data = join(root, 'data');
      await writeFile(join(data, 'proj-code-review-requirements-output.txt'), 'out\n');
      await writeFile(join(data, 'proj-code-review-requirements-launches.txt'), '1\n');
      await writeFile(join(data, 'proj-code-review-requirements-session.json'), '{}\n');
      await writeFile(join(data, 'proj-code-review-plan-output.txt'), 'out\n');
      await history.remove(review);
      expect(existsSync(join(data, 'proj-code-review-requirements-output.txt'))).toBe(true);
      expect(existsSync(join(data, 'proj-code-review-requirements-launches.txt'))).toBe(true);
      expect(existsSync(join(data, 'proj-code-review-requirements-session.json'))).toBe(true);
      expect(existsSync(join(data, 'proj-code-review-plan-output.txt'))).toBe(false);
      expect(await history.findRun('proj')).not.toBeNull();
      expect(await history.findRun('proj-code-review')).toBeNull();
      await history.remove(proj);
      expect(existsSync(join(data, 'proj-code-review-requirements-output.txt'))).toBe(false);
      expect(existsSync(join(data, 'proj-code-review-requirements-launches.txt'))).toBe(false);
      expect(existsSync(join(data, 'proj-code-review-requirements-session.json'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('stops a run before deleting its rows and files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-delete-'));
    const events: string[] = [];
    const pipeline = {
      startDetached: jest.fn(),
      stop: jest.fn(async () => {
        events.push('stop');
        return { exitCode: 0, message: 'proj-70 stopped' };
      }),
    };
    const prepare = { removeWorktrees: jest.fn() };
    const app = await boot(root, pipeline, prepare);
    try {
      const history = app.get(HistoryService);
      await save(history, 'proj-70', 'implement', 'running');
      const file = join(root, 'data', 'proj-70-implement-output.txt');
      await writeFile(file, 'out\n');
      prepare.removeWorktrees.mockImplementation(async () => {
        events.push('worktrees');
        expect(existsSync(file)).toBe(true);
        expect(await history.findRun('proj-70')).not.toBeNull();
      });
      expect(await app.get(RunsService).remove('proj-70')).toEqual({ key: 'proj-70' });
      expect(events).toEqual(['stop', 'worktrees']);
      expect(pipeline.stop).toHaveBeenCalledWith('proj-70');
      expect(prepare.removeWorktrees).toHaveBeenCalledWith('proj-70');
      expect(await history.findRun('proj-70')).toBeNull();
      expect(existsSync(file)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('keeps a run when stop fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-delete-busy-'));
    const pipeline = { startDetached: jest.fn(), stop: jest.fn().mockResolvedValue({ exitCode: 1, message: 'proj-71 is still running' }) };
    const prepare = { removeWorktrees: jest.fn() };
    const app = await boot(root, pipeline, prepare);
    try {
      const history = app.get(HistoryService);
      await save(history, 'proj-71', 'implement', 'running');
      const file = join(root, 'data', 'proj-71-implement-output.txt');
      await writeFile(file, 'out\n');
      await expect(app.get(RunsService).remove('proj-71')).rejects.toBeInstanceOf(ConflictException);
      expect(prepare.removeWorktrees).not.toHaveBeenCalled();
      expect(await history.findRun('proj-71')).not.toBeNull();
      expect(existsSync(file)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('answers not found when the run is missing and rejects a bad key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-delete-missing-'));
    const pipeline = { startDetached: jest.fn(), stop: jest.fn() };
    const app = await boot(root, pipeline);
    try {
      const runs = app.get(RunsService);
      await expect(runs.remove('missing-run')).rejects.toBeInstanceOf(NotFoundException);
      await expect(runs.remove('Bad Key')).rejects.toBeInstanceOf(BadRequestException);
      expect(pipeline.stop).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

async function boot(
  root: string,
  pipeline: { startDetached: jest.Mock; stop?: jest.Mock; replay?: jest.Mock; claimed?: (key: string) => boolean } = {
    startDetached: jest.fn(),
  },
  prepare: { removeWorktrees: jest.Mock } = { removeWorktrees: jest.fn().mockResolvedValue(undefined) },
) {
  await writeFile(
    join(root, '.env'),
    [
      'RUNTIME=cursor',
      'REQUIREMENTS_VIA=direct',
      'ISSUE_TRACKER=jira',
      'JIRA_BASE_URL=',
      'JIRA_EMAIL=',
      'JIRA_API_TOKEN=',
      'GITLAB_BASE_URL=https://gitlab.example',
      'GITLAB_TOKEN=token',
      'GITHUB_BASE_URL=',
      'GITHUB_TOKEN=',
      'CURSOR_API_KEY=',
      'ANTHROPIC_API_KEY=',
      'MAX_AGENT_CALLS=20',
      'MAX_RETURNS=3',
      'MAX_LAUNCHES=3',
      'MAX_RUN_USD=25',
      'IDLE_TIMEOUT_MS=900000',
      'TICK_MS=15000',
      'REQUIREMENTS_TIMEOUT_MS=600000',
      'RESEARCH_TIMEOUT_MS=900000',
      'PLAN_TIMEOUT_MS=1200000',
      'IMPLEMENT_TIMEOUT_MS=1800000',
      'CODE_REVIEW_TIMEOUT_MS=900000',
      'MERGE_REQUEST_TIMEOUT_MS=600000',
      'PIPELINE_TIMEOUT_MS=1800000',
      'PIPELINE_START_TIMEOUT_MS=180000',
      'MODEL_RESEARCH=grok-4.7',
      'MODEL_PLAN=opus-5.5-extra-high',
      'MODEL_IMPLEMENT=grok-4.7',
      'SWARMLOOP_API_PORT=3920',
      'SWARMLOOP_API_HOST=127.0.0.1',
      `SWARMLOOP_ROOT=${root}`,
    ].join('\n'),
  );
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), HistoryModule, LiveModule],
    providers: [
      RunsService,
      { provide: PipelineService, useValue: { claimed: () => false, ...pipeline } },
      { provide: ProjectAppendService, useValue: { add: jest.fn(), flush: jest.fn() } },
      { provide: PrepareService, useValue: prepare },
    ],
  }).compile();
}

function visit(step: string, status: string): VisitDraft {
  const now = new Date().toISOString();
  return {
    step,
    model: null,
    mode: null,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    status,
    exitCode: 0,
    killReason: null,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    samples: [],
    exchange: null,
    httpCalls: [],
    document: null,
    resumed: false,
  };
}

async function remember(history: HistoryService, key: string, step: string, status: string) {
  const run = await save(history, key, step, status);
  await history.putDocument(
    run,
    'requirements',
    `${JSON.stringify({
      prompt: 'Ship the field\n',
      tickets: [{ key, summary: 'Ship the field', description: '', acceptanceCriteria: '', comments: [] }],
      epic: null,
      epics: [],
      files: [],
      pages: [],
    })}\n`,
  );
  await history.putDocument(run, 'repos', 'demo\n');
  return run;
}

function featureWorktree(root: string, key: string, repo = 'demo'): { tree: string; clone: string } {
  const clone = join(root, repo);
  const remote = join(root, `${repo}.git`);
  const tree = join(root, 'worktrees', key, repo);
  git(root, ['init', '-b', 'main', clone]);
  git(clone, ['config', 'user.email', 'dev@example.com']);
  git(clone, ['config', 'user.name', 'Dev']);
  mkdirSync(join(clone, 'src'), { recursive: true });
  writeFileSync(join(clone, 'src', 'readme.ts'), 'export const readme = 1;\n');
  git(clone, ['add', 'src/readme.ts']);
  git(clone, ['commit', '-m', 'init']);
  git(root, ['init', '--bare', remote]);
  git(clone, ['remote', 'add', 'origin', remote]);
  git(clone, ['push', '-u', 'origin', 'main']);
  git(clone, ['switch', '-c', 'holder']);
  mkdirSync(join(tree, '..'), { recursive: true });
  git(clone, ['worktree', 'add', '-b', `feature/${key}-ship-the-field`, tree, 'main']);
  return { tree, clone };
}

async function denyEnv(app: Awaited<ReturnType<typeof boot>>): Promise<void> {
  const deny = app.get<Repository<DenyPathEntity>>(getRepositoryToken(DenyPathEntity));
  await deny.save(deny.create({ pattern: '.env' }));
}

function isAncestor(cwd: string, base: string): boolean {
  try {
    git(cwd, ['merge-base', '--is-ancestor', base, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function hostFetch(bare: string, token: string): () => void {
  const entries = [
    ['protocol.file.allow', 'always'],
    [`url.${bare}.insteadOf`, `https://oauth2:${token}@gitlab.example/group/demo.git`],
  ];
  const start = Number(process.env.GIT_CONFIG_COUNT);
  const base = Number.isInteger(start) && start > 0 ? start : 0;
  const savedCount = process.env.GIT_CONFIG_COUNT;
  const saved = entries.map((_, index) => {
    const slot = String(base + index);
    return { slot, key: process.env[`GIT_CONFIG_KEY_${slot}`], value: process.env[`GIT_CONFIG_VALUE_${slot}`] };
  });
  entries.forEach(([key, value], index) => {
    const slot = String(base + index);
    process.env[`GIT_CONFIG_KEY_${slot}`] = key;
    process.env[`GIT_CONFIG_VALUE_${slot}`] = value;
  });
  process.env.GIT_CONFIG_COUNT = String(base + entries.length);
  return () => {
    if (savedCount === undefined) {
      delete process.env.GIT_CONFIG_COUNT;
    } else {
      process.env.GIT_CONFIG_COUNT = savedCount;
    }
    for (const item of saved) {
      if (item.key === undefined) {
        delete process.env[`GIT_CONFIG_KEY_${item.slot}`];
      } else {
        process.env[`GIT_CONFIG_KEY_${item.slot}`] = item.key;
      }
      if (item.value === undefined) {
        delete process.env[`GIT_CONFIG_VALUE_${item.slot}`];
      } else {
        process.env[`GIT_CONFIG_VALUE_${item.slot}`] = item.value;
      }
    }
  };
}

async function save(history: HistoryService, key: string, step: string, status: string, attemptsReview = 0) {
  const run = await history.begin(key, step);
  run.status = status;
  run.currentStep = step;
  run.ownerPid = null;
  run.attemptsReview = attemptsReview;
  return history.saveRun(run);
}
