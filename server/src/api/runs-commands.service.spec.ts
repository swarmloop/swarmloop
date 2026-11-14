import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommandService } from '../pipeline/command.service';
import { deriveState } from '../history/run-state';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { VisitRepository } from '../history/visit.repository';
import { FlowRepository } from '../history/flow.repository';
import type { IssueTracker } from '../integrations/issue-tracker/issue-tracker';
import { ISSUE_TRACKER } from '../integrations/issue-tracker/tokens';
import { PHASES } from '../contract/steps';
import { RunCommandsService } from './run-commands.service';
import { RunSubtaskCommandsService } from './run-subtask-commands.service';
import { AppConfig } from '../config/env';
import { RunQueriesService } from './run-queries.service';
import { httpStatus } from './runs.controller';
import { boot, save, visit } from '../testing/runs.spec-helpers';
import type { Subtask } from '../contract/subtask';

describe('runs api', () => {
  it('lists runs newest first and draws a return edge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      await save(runs, 'alpha', 'prepare', 'waiting');
      const second = await save(runs, 'beta', 'implement', 'waiting', 2);
      await save(runs, 'alpha', 'prepare', 'waiting');
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

  it('asks the tracker for the keys of the person who plans a run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-actor-'));
    const app = await boot(root);
    try {
      const tracker = app.get<IssueTracker>(ISSUE_TRACKER);
      const keys = jest.spyOn(tracker, 'ticketKeys').mockResolvedValue(['PROJ-9']);
      const runs = app.get(RunCommandsService);
      expect(await runs.ticketKeys({ prompt: 'Do PROJ-9' }, 'ann')).toEqual({ keys: ['PROJ-9'] });
      expect(keys).toHaveBeenLastCalledWith('Do PROJ-9', 'ann');
      expect((await runs.plan({ prompt: 'Do PROJ-9', projects: ['demo'] }, 'bob')).key).toBe('PROJ-9');
      expect(keys).toHaveBeenLastCalledWith('Do PROJ-9', 'bob');
    } finally {
      await app.close();
    }
  });

  it('names a run from the first line of the prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-name-'));
    const app = await boot(root);
    try {
      const runRepository = app.get(RunRepository);
      const runs = app.get(RunQueriesService);
      const long = `${'a'.repeat(120)}bc`;
      const named = await save(runRepository, 'named', 'prepare', 'waiting');
      named.prompt = 'Ship the field\nmore than the first line';
      await runRepository.saveRun(named);
      const cut = await save(runRepository, 'cut', 'prepare', 'waiting');
      cut.prompt = `${long}\nrest`;
      await runRepository.saveRun(cut);
      const blank = await save(runRepository, 'blank', 'prepare', 'waiting');
      blank.prompt = '  \n';
      await runRepository.saveRun(blank);
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
      const runRepository = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await save(runRepository, 'proj-3', 'research', 'waiting');
      await documents.putDocument(run, 'questions', '- which limit\n');
      const runs = app.get(RunCommandsService);
      await expect(runs.resume('proj-3')).rejects.toBeInstanceOf(BadRequestException);
      const answered = await runs.answers('proj-3', {
        answers: [{ kind: 'question', id: 'which limit', body: 'three' }],
      });
      expect(answered.resume).toBe('running');
      expect(await documents.latestBody('proj-3', 'answers')).toContain('answer: three');
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-3');
    } finally {
      await app.close();
    }
  });

  it('starts a single code reviewer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-reviewer-'));
    const pipeline = {
      startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }),
      claimed: () => false,
    };
    const app = await boot(root, pipeline);
    try {
      await save(app.get(RunRepository), 'proj-reviewer', 'code-review', 'waiting');
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
    const pipeline = {
      startDetached: jest.fn(),
      replay: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-11 started' }),
    };
    const app = await boot(root, pipeline);
    try {
      await save(app.get(RunRepository), 'proj-11', 'implement-improve', 'failed');
      const result = await app.get(RunCommandsService).replay('proj-11', 'implement', 'Use the other parser');
      expect(result).toEqual({ key: 'proj-11', status: 'started' });
      expect(httpStatus(result)).toBe(202);
      expect(pipeline.replay).toHaveBeenCalledWith('proj-11', 'implement', 'Use the other parser');
    } finally {
      await app.close();
    }
  });

  it('names a run from a typed key, and from a slug when the prompt only looks like a key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-slug-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunCommandsService);
      const prompt = 'Use UTF-8, SHA-256, ISO-8601, GPT-4 and CVE-2026-1234';
      const plain = await runs.plan({ prompt, projects: ['demo'] });
      expect(plain.key).toMatch(/^run-/);
      const typed = await runs.plan({ key: 'PROJ-123', prompt, projects: ['demo'] });
      expect(typed.key).toBe('PROJ-123');
      expect(await runs.ticketKeys({ prompt })).toEqual({ keys: [] });
      expect(await runs.ticketKeys({ prompt, key: 'PROJ-123' })).toEqual({ keys: ['PROJ-123'] });
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
      const runRepository = app.get(RunRepository);
      const flows = app.get(FlowRepository);
      await runs.start({
        key: 'proj-12',
        prompt: 'Review the checkout',
        phases: ['planning', 'code-review'],
        projects: ['demo'],
      });
      await runs.replay('proj-12', 'code-review', 'Skip the pipeline', ['planning', 'code-review', 'ci']);
      const run = await runRepository.findRun('proj-12');
      const rows = await flows.listFlows(run?.id ?? 0);
      expect(rows.map((row) => ({ phases: JSON.parse(row.phases) as string[], fromStep: row.fromStep }))).toEqual([
        { phases: ['planning', 'code-review'], fromStep: null },
        { phases: ['planning', 'code-review', 'ci'], fromStep: 'code-review' },
      ]);
      await expect(runs.start({ key: 'proj-13', prompt: 'Nope', phases: ['nope'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    } finally {
      await app.close();
    }
  });

  it('stops a running step without starting it again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-stop-'));
    const pipeline = {
      startDetached: jest.fn(),
      stop: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-9 stopped' }),
    };
    const app = await boot(root, pipeline);
    try {
      await save(app.get(RunRepository), 'proj-9', 'implement-improve', 'running');
      const result = await app.get(RunCommandsService).stop('proj-9');
      expect(result).toEqual({ key: 'proj-9', status: 'stopped' });
      expect(httpStatus(result)).toBe(200);
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
      await save(app.get(RunRepository), 'proj-4', 'prepare', 'blocked');
      await expect(app.get(RunCommandsService).resume('proj-4')).rejects.toBeInstanceOf(ConflictException);
    } finally {
      await app.close();
    }
  });

  it('resumes a blocked looping step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-loop-'));
    const pipeline = {
      startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }),
      claimed: () => false,
    };
    const app = await boot(root, pipeline);
    try {
      await save(app.get(RunRepository), 'proj-loop', 'code-review', 'blocked');
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
    const pipeline = {
      startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }),
      claimed: () => false,
    };
    const app = await boot(root, pipeline);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await save(runs, 'proj-fit', 'code-review', 'blocked');
      await documents.putDocument(run, 'error', 'code-review does not fit\n');
      const flow = await app.get(RunQueriesService).flow('proj-fit');
      expect(flow.resume).toBe('ready');
      expect(flow.sentence).toContain('agent-call budget');
      await app.get(RunCommandsService).resume('proj-fit');
      expect(pipeline.startDetached).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('resumes a block from a repeated required check into implement-improve with the stored notes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-check-'));
    const pipeline = {
      startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }),
      claimed: () => false,
    };
    const app = await boot(root, pipeline);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await save(runs, 'proj-check', 'implement-improve', 'blocked');
      await documents.putDocument(run, 'issues', '- the unit test for the field fails\n');
      await documents.putDocument(run, 'error', 'repo: npm test failed again on unchanged files after a relaunch\n');
      const flow = await app.get(RunQueriesService).flow('proj-check');
      expect(flow.resume).toBe('ready');
      expect(flow.state).toBe('blocked');
      expect(flow.stateReason?.code).toBe('CHECK_FAILED');
      expect(flow.actions).toEqual(['resume', 'replay']);
      expect(flow.sentence).toContain('Resume returns to implementation with the stored notes');
      await expect(app.get(RunCommandsService).resume('proj-check')).resolves.toEqual({
        key: 'proj-check',
        status: 'started',
      });
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-check', {});
      expect(await documents.latestBody('proj-check', 'issues')).toBe('- the unit test for the field fails\n');
      expect((await runs.findRun('proj-check'))?.currentStep).toBe('implement-improve');
    } finally {
      await app.close();
    }
  });

  it('offers only Replay on a block that Resume cannot continue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-actions-'));
    const app = await boot(root);
    try {
      await save(app.get(RunRepository), 'proj-prepare', 'prepare', 'blocked');
      const flow = await app.get(RunQueriesService).flow('proj-prepare');
      expect(flow.resume).toBe('blocked');
      expect(flow.actions).toEqual(['replay']);
    } finally {
      await app.close();
    }
  });

  it('keeps the prompt when a checkout starts code review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-path-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-7 started' }) };
    const app = await boot(root, pipeline);
    try {
      const path = join(root, 'worktrees', 'checkout');
      const started = await app.get(RunCommandsService).start({ key: 'proj-7', prompt: 'Look here', path });
      expect(httpStatus(started)).toBe(202);
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-7', { path, phases: [...PHASES] }, 'code-review');
      expect((await app.get(RunRepository).findRun('proj-7'))?.prompt).toBe('Look here');
    } finally {
      await app.close();
    }
  });

  it('refuses a path outside the repositories before it creates anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-outside-'));
    const pipeline = { startDetached: jest.fn() };
    const app = await boot(root, pipeline);
    try {
      await expect(
        app.get(RunCommandsService).start({ key: 'proj-8', prompt: 'Look here', path: tmpdir() }),
      ).rejects.toThrow('path is outside the repositories');
      expect(pipeline.startDetached).not.toHaveBeenCalled();
      expect(await app.get(RunRepository).findRun('proj-8')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('opens the next session even when an earlier one is still running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-parked-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }) };
    const app = await boot(root, pipeline);
    try {
      const runs = app.get(RunRepository);
      const previous = await save(runs, 'PROJ-12', 'code-review', 'failed');
      previous.prompt = 'old brief\n';
      await runs.saveRun(previous);
      await save(runs, 'PROJ-12--2', 'done', 'done');
      const live = await save(runs, 'PROJ-12--3', 'code-review', 'running');
      live.ownerPid = process.pid;
      await runs.saveRun(live);
      const prompt = 'https://example.atlassian.net/browse/PROJ-12\nbranch: feature/PROJ-12-add-export';
      const started = await app.get(RunCommandsService).start({
        prompt,
        phases: ['planning', 'code-review'],
        projects: ['billing-api'],
      });
      expect(httpStatus(started)).toBe(202);
      expect(started.key).toBe('PROJ-12--4');
      expect(pipeline.startDetached).toHaveBeenCalledWith('PROJ-12--4', {
        prompt,
        projects: ['billing-api'],
        phases: ['planning', 'code-review'],
      });
      expect((await runs.findRun('PROJ-12'))?.prompt).toBe('old brief\n');
      expect((await runs.findRun('PROJ-12--3'))?.status).toBe('running');
    } finally {
      await app.close();
    }
  });

  it('opens a new session when the ticket run is done', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-session-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }) };
    const app = await boot(root, pipeline);
    try {
      await save(app.get(RunRepository), 'PROJ-12', 'done', 'done');
      const prompt = 'https://example.atlassian.net/browse/PROJ-12\nbranch: feature/PROJ-12-add-export';
      const started = await app.get(RunCommandsService).start({
        prompt,
        phases: ['planning', 'code-review'],
        projects: ['billing-api'],
      });
      expect(httpStatus(started)).toBe(202);
      expect(started.key).toBe('PROJ-12--2');
      expect(pipeline.startDetached).toHaveBeenCalledWith('PROJ-12--2', {
        prompt,
        projects: ['billing-api'],
        phases: ['planning', 'code-review'],
      });
      expect((await app.get(RunRepository).findRun('PROJ-12'))?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('uses a ticket key from the prompt when no run id is sent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-ticket-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }) };
    const app = await boot(root, pipeline);
    try {
      const started = await app
        .get(RunCommandsService)
        .start({ prompt: 'Ship PROJ-15 before Friday', projects: ['demo'] });
      expect(httpStatus(started)).toBe(202);
      expect(started.key).toBe('PROJ-15');
      expect(pipeline.startDetached).toHaveBeenCalledWith('PROJ-15', {
        prompt: 'Ship PROJ-15 before Friday',
        projects: ['demo'],
        phases: [...PHASES],
      });
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
      expect(started.key).toMatch(/^run-[a-z0-9]+$/);
      expect(pipeline.startDetached).toHaveBeenCalledWith(started.key, {
        prompt: 'Ship the field',
        projects: ['demo'],
        phases: [...PHASES],
      });
    } finally {
      await app.close();
    }
  });

  it('does not ask for a clone while prepare is waiting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-clones-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const run = await save(runs, 'proj-9', 'prepare', 'waiting');
      await visits.finishVisit(run, visit('prepare', 'waiting'));
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
      const started = await app
        .get(RunCommandsService)
        .start({ key: 'proj-5', prompt: 'Ship the field', projects: ['demo'] });
      expect(httpStatus(started)).toBe(202);
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-5', {
        prompt: 'Ship the field',
        projects: ['demo'],
        phases: [...PHASES],
      });
    } finally {
      await app.close();
    }
  });

  describe('split', () => {
    const body = { key: 'proj-6', prompt: 'Ship the field', projects: ['demo'] };

    async function planned(split: 'auto' | 'off', extra: { split?: boolean } = {}) {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-split-'));
      const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }) };
      const app = await boot(root, pipeline);
      app.get(AppConfig).env.SPLIT = split;
      try {
        const commands = app.get(RunCommandsService);
        const plan = await commands.plan({ ...body, ...extra });
        await commands.start({ ...body, ...extra });
        return { plan, row: await app.get(RunRepository).findRun(plan.key) };
      } finally {
        await app.close();
      }
    }

    it('split defaults from SPLIT', async () => {
      expect((await planned('off')).plan.split).toBe(false);
      expect((await planned('off')).row?.split).toBe(false);
      const auto = await planned('auto');
      expect(auto.plan.split).toBe(true);
      expect(auto.row?.split).toBe(true);
    });

    it('the body value wins for a new run', async () => {
      const on = await planned('off', { split: true });
      expect(on.row?.split).toBe(true);
      expect((await planned('auto', { split: false })).plan.split).toBe(false);
    });

    it('a subtask is always off', async () => {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-split-subtask-'));
      const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }) };
      const app = await boot(root, pipeline);
      app.get(AppConfig).env.SPLIT = 'auto';
      try {
        const parent = await save(app.get(RunRepository), 'PROJ-301', 'implement', 'waiting');
        parent.projects = 'demo\n';
        await app.get(RunRepository).saveRun(parent);
        await app.get(DocumentRepository).putDocument(parent, 'requirements', '{"prompt":"Ship"}\n');
        const task: Subtask = {
          id: 't1',
          title: 'T',
          description: '',
          depends: [],
          files: [],
          proof: 'p',
          status: 'pending',
        };
        await app.get(RunSubtaskCommandsService).startSubtask(parent, task);
        expect((await app.get(RunRepository).findRun('PROJ-301-t1'))?.split).toBe(false);
      } finally {
        await app.close();
      }
    });
  });

  describe('subtasks', () => {
    const task: Subtask = {
      id: 't1',
      title: 'Add the field',
      description: 'Store it.',
      depends: [],
      files: ['src/a.ts'],
      proof: 'a test',
      status: 'pending',
    };

    async function parentRun(app: Awaited<ReturnType<typeof boot>>) {
      const parent = await save(app.get(RunRepository), 'PROJ-300', 'implement', 'waiting');
      parent.projects = 'demo\n';
      await app.get(RunRepository).saveRun(parent);
      const documents = app.get(DocumentRepository);
      await documents.putDocument(
        parent,
        'requirements',
        `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [{ key: 'PROJ-300', summary: 'Ship the field' }] })}\n`,
      );
      await documents.putDocument(parent, 'contract', '- decided: use a column\n');
      return parent;
    }

    it('makes one run for one task, however often it is started', async () => {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-subtask-'));
      const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }) };
      const app = await boot(root, pipeline);
      try {
        const parent = await parentRun(app);
        const commands = app.get(RunSubtaskCommandsService);
        const first = await commands.startSubtask(parent, task);
        const second = await commands.startSubtask(parent, task);

        expect(second).toEqual(first);
        expect(first.key).toBe('PROJ-300-t1');
        expect(pipeline.startDetached).toHaveBeenCalledTimes(1);
        expect(
          (await app.get(FlowRepository).listFlows((await app.get(RunRepository).findRun('PROJ-300-t1'))!.id)).length,
        ).toBe(1);
        const row = await app.get(RunRepository).findRun('PROJ-300-t1');
        expect(row).toMatchObject({ parentRunId: parent.id, taskId: 't1' });
        expect((await app.get(RunRepository).children(parent)).map((run) => run.key)).toEqual(['PROJ-300-t1']);
      } finally {
        await app.close();
      }
    });

    it('starts from the task, the parent brief and one branch line, without the contract', async () => {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-subtask-prompt-'));
      const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }) };
      const app = await boot(root, pipeline);
      try {
        await app.get(RunSubtaskCommandsService).startSubtask(await parentRun(app), task);

        const [key, start] = pipeline.startDetached.mock.calls[0] as [string, { prompt: string; projects: string[] }];
        expect(key).toBe('PROJ-300-t1');
        expect(start.projects).toEqual(['demo']);
        expect(start.prompt).toContain('Add the field');
        expect(start.prompt).toContain('Store it.');
        expect(start.prompt).toContain('files: src/a.ts');
        expect(start.prompt).toContain('proof: a test');
        expect(start.prompt).toContain('Ship the field');
        expect(start.prompt.match(/^branch: /gm)).toEqual(['branch: ']);
        expect(start.prompt).toContain('branch: feature/PROJ-300-ship-the-field');
        expect(start.prompt).not.toContain('use a column');
      } finally {
        await app.close();
      }
    });

    it('lists a subtask with its parent key and the parent page names its parent', async () => {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-subtask-list-'));
      const app = await boot(root, { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }) });
      try {
        await app.get(RunSubtaskCommandsService).startSubtask(await parentRun(app), task);

        const queries = app.get(RunQueriesService);
        const listed = (await queries.list()).runs;
        expect(listed.find((run) => run.key === 'PROJ-300-t1')).toMatchObject({ parentKey: 'PROJ-300', taskId: 't1' });
        expect(listed.find((run) => run.key === 'PROJ-300')).not.toHaveProperty('parentKey');
        expect((await queries.flow('PROJ-300-t1')).parentKey).toBe('PROJ-300');
      } finally {
        await app.close();
      }
    });
  });

  describe('Skip task', () => {
    const taskList = ['a', 'b'].map((id) => ({
      id,
      title: id,
      description: '',
      depends: [],
      files: [`src/${id}.ts`],
      proof: 'p',
      status: 'running',
    }));

    it.each([
      ['failed', 'failed'],
      ['blocked', 'blocked'],
      ['running', 'running'],
    ])('closes a %s child: it shows skipped and every command on it is refused', async (_name, status) => {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-skip-'));
      const app = await boot(root);
      try {
        const runs = app.get(RunRepository);
        const parent = await save(runs, 'proj-skip', 'implement', 'waiting');
        parent.split = true;
        await runs.saveRun(parent);
        await app.get(DocumentRepository).putDocument(parent, 'subtasks', `${JSON.stringify(taskList)}\n`);
        const child = await save(runs, 'proj-skip-a', 'implement', status);
        child.parentRunId = parent.id;
        child.taskId = 'a';
        await runs.saveRun(child);

        app.get(CommandService).register('stop', async (key) => ({ key, status: 'stopped' }));
        await app.get(RunSubtaskCommandsService).skipTask('proj-skip', 'a');

        expect(deriveState((await runs.findRun('proj-skip-a'))!).state).toBe('skipped');
        const commands = app.get(CommandService);
        for (const type of ['resume', 'replay', 'rebase'] as const) {
          await expect(commands.submit(type, 'proj-skip-a', { step: 'implement', prompt: 'x' })).rejects.toThrow(
            'this task was skipped',
          );
        }
        await expect(app.get(RunSubtaskCommandsService).skipTask('proj-skip', 'a')).resolves.toBeDefined();
      } finally {
        await app.close();
      }
    });
  });

  it('answers a resume of a running split parent as started, and of any other running run as already running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-pass-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const parent = await save(runs, 'proj-pass', 'implement', 'running');
      parent.split = true;
      parent.ownerPid = process.pid;
      await runs.saveRun(parent);
      const child = await save(runs, 'proj-pass-a', 'research', 'running');
      child.parentRunId = parent.id;
      child.taskId = 'a';
      await runs.saveRun(child);
      const plain = await save(runs, 'proj-plain', 'implement', 'running');
      plain.ownerPid = process.pid;
      await runs.saveRun(plain);
      const commands = app.get(RunCommandsService);

      await expect(commands.resume('proj-pass')).resolves.toEqual({ key: 'proj-pass', status: 'started' });
      await expect(commands.resume('proj-plain')).rejects.toThrow('proj-plain is already running');
    } finally {
      await app.close();
    }
  });
});
