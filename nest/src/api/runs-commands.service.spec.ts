import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { HistoryService } from '../history/history.service';
import { PHASES } from '../pipeline/pipeline-result';
import { RunCommandsService } from './run-commands.service';
import { RunQueriesService } from './run-queries.service';
import { boot, save, visit } from './runs.spec-helpers';

describe('runs api', () => {
  it('lists runs newest first and draws a return edge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      await save(history, 'alpha', 'prepare', 'waiting');
      const second = await save(history, 'beta', 'implement', 'waiting', 2);
      await save(history, 'alpha', 'prepare', 'waiting');
      const listed = await app.get(RunQueriesService).list();
      expect(listed.runs.map((run) => run.key)).toEqual(['beta', 'alpha']);
      const flow = await app.get(RunQueriesService).flow('beta');
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
      const runs = app.get(RunQueriesService);
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
      const runs = app.get(RunCommandsService);
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
      await app.get(RunCommandsService).startStep('proj-reviewer', 'code-review-quality');
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
      const result = await app.get(RunCommandsService).replay('proj-11', 'implement', 'Use the other parser');
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
      const runs = app.get(RunCommandsService);
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
      const result = await app.get(RunCommandsService).stop('proj-9');
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
      await expect(app.get(RunCommandsService).resume('proj-4')).rejects.toBeInstanceOf(ConflictException);
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
      const flow = await app.get(RunQueriesService).flow('proj-loop');
      expect(flow.resume).toBe('ready');
      await app.get(RunCommandsService).resume('proj-loop');
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
      const flow = await app.get(RunQueriesService).flow('proj-fit');
      expect(flow.resume).toBe('ready');
      expect(flow.sentence).toContain('agent-call budget');
      await app.get(RunCommandsService).resume('proj-fit');
      expect(pipeline.startDetached).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('keeps the prompt when a checkout starts code review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-path-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-7 started' }) };
    const app = await boot(root, pipeline);
    try {
      const started = await app.get(RunCommandsService).start({ key: 'proj-7', prompt: 'Look here', path: '/tmp/checkout' });
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
      const started = await app.get(RunCommandsService).start({
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
      const started = await app.get(RunCommandsService).start({
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
      const started = await app.get(RunCommandsService).start({ prompt: 'Ship PROJ-15 before Friday', projects: ['demo'] });
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
      const started = await app.get(RunCommandsService).start({ prompt: 'Ship the field', projects: ['demo'] });
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
      const flow = await app.get(RunQueriesService).flow('proj-9');
      expect(flow.sentence).toBe('The next continuation prepares the worktrees.');
      expect(flow.items).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('starts a new run in the background', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-start-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-5 started' }) };
    const app = await boot(root, pipeline);
    try {
      const started = await app.get(RunCommandsService).start({ key: 'proj-5', prompt: 'Ship the field', projects: ['demo'] });
      expect(started.http).toBe(202);
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-5', { prompt: 'Ship the field', projects: ['demo'], phases: [...PHASES] });
    } finally {
      await app.close();
    }
  });
});
