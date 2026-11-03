import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { VisitRepository } from '../history/visit.repository';
import { FlowRepository } from '../history/flow.repository';
import { EventRepository } from '../history/event.repository';
import { CheckoutRepository } from '../history/checkout.repository';
import { LiveHub } from '../live/live.hub';
import { RunCommandsService } from './run-commands.service';
import { boot, save, visit, denyEnv } from './runs.spec-helpers';

describe('runs api', () => {
  it('removes the rows and files of one run and leaves the shared store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-remove-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const visits = app.get(VisitRepository);
      const flows = app.get(FlowRepository);
      const events = app.get(EventRepository);
      const checkouts = app.get(CheckoutRepository);
      const run = await save(runs, 'PROJ-20', 'plan', 'waiting');
      const now = new Date().toISOString();
      await visits.finishVisit(run, {
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
        httpCalls: [
          { provider: 'jira', method: 'GET', url: 'http://jira', statusCode: 200, durationMs: 1, error: null },
        ],
      });
      await documents.putDocument(run, 'requirements', 'body\n');
      await flows.noteFlow('PROJ-20', ['requirements'], null);
      await events.recordLoop(run, 'review', 1, 'again');
      await checkouts.savePaste('PROJ-20', 'http://paste', 'pasted');
      await checkouts.saveCheckout('demo', join(root, 'demo'));
      await denyEnv(app);
      const kept = await save(runs, 'keep', 'plan', 'waiting');
      await documents.putDocument(kept, 'requirements', 'stay\n');
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
      const stats = await visits.listStats(run.id);
      const ids = stats.map((stat) => stat.id);
      expect(ids).toHaveLength(1);
      const hub = app.get(LiveHub);
      hub.log({ key: 'PROJ-20', step: 'plan', body: '', usage: { tokensIn: 1, tokensOut: 1, usd: 1 } });
      const seen: string[] = [];
      const off = hub.onChanged((key) => seen.push(key));
      await runs.remove(run);
      off();
      expect(seen).toEqual(['PROJ-20']);
      expect(hub.spendOf('PROJ-20')).toBeUndefined();
      expect(await runs.findRun('PROJ-20')).toBeNull();
      expect(await documents.listDocuments(run.id)).toEqual([]);
      expect(await visits.listStats(run.id)).toEqual([]);
      expect(await visits.listSamples(ids)).toEqual([]);
      expect(await visits.listExchanges(ids)).toEqual([]);
      expect(await events.listHttpCalls(run.id)).toEqual([]);
      expect(await events.listLoops(run.id)).toEqual([]);
      expect(await flows.listFlows(run.id)).toEqual([]);
      expect(await checkouts.listPastes('PROJ-20')).toEqual([]);
      expect(await runs.findRun('keep')).not.toBeNull();
      expect(await documents.listDocuments(kept.id)).toHaveLength(1);
      expect((await checkouts.listCheckouts()).map((row) => row.name)).toEqual(['demo']);
      expect(await checkouts.listDenyPaths()).toEqual(['.env']);
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
      const runs = app.get(RunRepository);
      const duration = await save(runs, 'proj-duration', 'plan', 'waiting');
      await save(runs, 'proj-duration-short', 'plan', 'waiting');
      const agent = await save(runs, 'agent', 'plan', 'waiting');
      const price = await save(runs, 'price', 'plan', 'waiting');
      const loop = await save(runs, 'swarmloop', 'plan', 'waiting');
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
      await runs.remove(duration);
      await runs.remove(agent);
      await runs.remove(price);
      await runs.remove(loop);
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
      expect(await runs.findRun('proj-duration-short')).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('keeps each run step file when the other id is that step name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-remove-step-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const ship = await save(runs, 'ship', 'plan', 'waiting');
      await save(runs, 'ship-plan', 'plan', 'waiting');
      const plan = await save(runs, 'proj-plan', 'plan', 'waiting');
      await save(runs, 'proj', 'plan', 'waiting');
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
      await runs.remove(ship);
      await runs.remove(plan);
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
      expect(await runs.findRun('ship')).toBeNull();
      expect(await runs.findRun('ship-plan')).not.toBeNull();
      expect(await runs.findRun('proj')).not.toBeNull();
      expect(await runs.findRun('proj-plan')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('keeps a requirements review file when the other id is that code-review prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-remove-review-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const proj = await save(runs, 'proj', 'code-review', 'waiting');
      const review = await save(runs, 'proj-code-review', 'requirements', 'waiting');
      const data = join(root, 'data');
      await writeFile(join(data, 'proj-code-review-requirements-output.txt'), 'out\n');
      await writeFile(join(data, 'proj-code-review-requirements-launches.txt'), '1\n');
      await writeFile(join(data, 'proj-code-review-requirements-session.json'), '{}\n');
      await writeFile(join(data, 'proj-code-review-plan-output.txt'), 'out\n');
      await runs.remove(review);
      expect(existsSync(join(data, 'proj-code-review-requirements-output.txt'))).toBe(true);
      expect(existsSync(join(data, 'proj-code-review-requirements-launches.txt'))).toBe(true);
      expect(existsSync(join(data, 'proj-code-review-requirements-session.json'))).toBe(true);
      expect(existsSync(join(data, 'proj-code-review-plan-output.txt'))).toBe(false);
      expect(await runs.findRun('proj')).not.toBeNull();
      expect(await runs.findRun('proj-code-review')).toBeNull();
      await runs.remove(proj);
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
      const runs = app.get(RunRepository);
      await save(runs, 'proj-70', 'implement', 'running');
      const file = join(root, 'data', 'proj-70-implement-output.txt');
      await writeFile(file, 'out\n');
      prepare.removeWorktrees.mockImplementation(async () => {
        events.push('worktrees');
        expect(existsSync(file)).toBe(true);
        expect(await runs.findRun('proj-70')).not.toBeNull();
      });
      expect(await app.get(RunCommandsService).remove('proj-70')).toEqual({ key: 'proj-70' });
      expect(events).toEqual(['stop', 'worktrees']);
      expect(pipeline.stop).toHaveBeenCalledWith('proj-70');
      expect(prepare.removeWorktrees).toHaveBeenCalledWith('proj-70');
      expect(await runs.findRun('proj-70')).toBeNull();
      expect(existsSync(file)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('keeps a run when stop fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-delete-busy-'));
    const pipeline = {
      startDetached: jest.fn(),
      stop: jest.fn().mockResolvedValue({ exitCode: 1, message: 'proj-71 is still running' }),
    };
    const prepare = { removeWorktrees: jest.fn() };
    const app = await boot(root, pipeline, prepare);
    try {
      const runs = app.get(RunRepository);
      await save(runs, 'proj-71', 'implement', 'running');
      const file = join(root, 'data', 'proj-71-implement-output.txt');
      await writeFile(file, 'out\n');
      await expect(app.get(RunCommandsService).remove('proj-71')).rejects.toBeInstanceOf(ConflictException);
      expect(prepare.removeWorktrees).not.toHaveBeenCalled();
      expect(await runs.findRun('proj-71')).not.toBeNull();
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
      const runs = app.get(RunCommandsService);
      await expect(runs.remove('missing-run')).rejects.toBeInstanceOf(NotFoundException);
      await expect(runs.remove('Bad Key')).rejects.toBeInstanceOf(BadRequestException);
      expect(pipeline.stop).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
