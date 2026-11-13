import 'reflect-metadata';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { DocumentRepository } from '../history/document.repository';

import { RunRepository } from '../history/run.repository';

import { VisitRepository } from '../history/visit.repository';

import { FlowRepository } from '../history/flow.repository';

import { LiveHub } from '../live/live.hub';

import { RunQueriesService } from './run-queries.service';

import { RunSubtaskCommandsService } from './run-subtask-commands.service';

import { boot, visit } from '../testing/runs.spec-helpers';

describe('runs api', () => {
  it('reports closed step time, the open step start, and live session peaks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-clock-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const visits = app.get(VisitRepository);
      const flows = app.get(FlowRepository);
      const hub = app.get(LiveHub);
      const run = await runs.begin('proj-clock', 'research');
      const started = run.stepStartedAt;
      await runs.saveRun(run);
      expect((await runs.findRun('proj-clock'))?.stepStartedAt).toBe(started);
      await visits.finishVisit(run, {
        ...visit('prepare', 'done'),
        durationMs: 5_000,
        samples: [{ sampledAt: new Date().toISOString(), cpuPercent: 12, rssBytes: 1024, source: 'agent' }],
      });
      hub.log({
        key: 'proj-clock',
        step: 'research',
        body: 'live\n',
        samples: [{ at: new Date().toISOString(), cpu: 80, memory: 4096, source: 'agent' }],
      });
      const flow = await app.get(RunQueriesService).flow('proj-clock');
      expect(flow.stepStartedAt).toBe(started);
      expect(flow.status).toBe('running');
      expect(flow.metrics.durationMs).toBe(5_000);
      expect(flow.metrics.closedStarts).toEqual([started]);
      expect(flow.metrics.cpuPeak).toBe(80);
      expect(flow.metrics.memPeak).toBe(4096);
      run.stepStartedAt = null;
      await runs.saveRun(run);
      await visits.finishVisit(run, { ...visit('research', 'failed'), durationMs: 4 });
      const later = await app.get(RunQueriesService).flow('proj-clock');
      expect(later.metrics.closedStarts).toEqual([started]);
      expect(later.metrics.durationMs).toBe(5_004);
      await flows.noteFlow('proj-wait', ['planning'], null);
      const waiting = await runs.findRun('proj-wait');
      expect(waiting?.status).toBe('waiting');
      expect(waiting?.stepStartedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('shows the tasks of a split run with their own runs, and the parent only with its own cost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-split-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const parent = await runs.begin('proj-split', 'implement');
      parent.spentUsd = 1;
      await runs.saveRun(parent);
      await documents.putDocument(
        parent,
        'requirements',
        JSON.stringify({ prompt: 'x', plan: { items: ['x'], decision: 'approve' } }),
      );
      const task = (id: string, status: string) => ({
        id,
        title: id.toUpperCase(),
        description: '',
        depends: [],
        files: [],
        proof: '',
        status,
      });
      await documents.putDocument(parent, 'subtasks', JSON.stringify([task('a', 'green'), task('b', 'merged')]));
      await documents.putDocument(parent, 'contract', 'decisions:\n- subtask a: store UTC\n');
      const child = await runs.openSubtask('proj-split-a', parent.id, 'a');
      child.spentUsd = 2.5;
      child.currentStep = 'ci';
      await runs.saveRun(child);

      const flow = await app.get(RunQueriesService).flow('proj-split');

      expect(flow.taskLine).toBe('Split: 2 tasks · 1 merged');
      expect(flow.mergeQueue).toEqual([{ id: 'a', title: 'A' }]);
      expect(flow.decisions).toBe('- subtask a: store UTC');
      const [a, b] = flow.tasks?.[0]?.tasks ?? [];
      expect(a?.run).toMatchObject({ key: 'proj-split-a', currentStep: 'ci', usd: 2.5 });
      expect(b?.run).toBeUndefined();
      expect(flow.metrics.usd).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('gives the parent its epic totals and depends on each task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-epic-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const parent = await runs.begin('proj-epic', 'implement');
      parent.spentUsd = 1;
      await runs.saveRun(parent);
      await documents.putDocument(
        parent,
        'requirements',
        JSON.stringify({ prompt: 'x', plan: { items: ['x'], decision: 'approve' } }),
      );
      const task = (id: string, depends: string[]) => ({
        id,
        title: id.toUpperCase(),
        description: '',
        depends,
        files: [],
        proof: '',
        status: 'waiting',
      });
      await documents.putDocument(parent, 'subtasks', JSON.stringify([task('a', []), task('b', ['a'])]));
      const child = await runs.openSubtask('proj-epic-a', parent.id, 'a');
      child.spentUsd = 2.5;
      await runs.saveRun(child);
      const alone = await runs.begin('proj-alone', 'implement');
      alone.spentUsd = 4;
      await runs.saveRun(alone);

      const queries = app.get(RunQueriesService);
      const flow = await queries.flow('proj-epic');
      const listed = (await queries.list()).runs;

      expect(flow.epic?.usd).toBe(3.5);
      expect(flow.epic?.durationMs).toBeGreaterThanOrEqual(0);
      expect(flow.tasks?.flatMap((layer) => layer.tasks.map((t) => t.depends))).toEqual([[], ['a']]);
      expect(listed.find((run) => run.key === 'proj-epic')?.epic?.usd).toBe(3.5);
      expect(listed.find((run) => run.key === 'proj-epic-a')?.epic).toBeUndefined();
      expect(listed.find((run) => run.key === 'proj-alone')?.epic).toBeUndefined();
      expect((await queries.flow('proj-alone')).epic).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('opens the subtask of a run for the person who started the parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-subtask-owner-'));
    const app = await boot(root);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const parent = await runs.begin('proj-owner', 'implement');
      parent.startedBy = 'alice';
      parent.projects = 'demo';
      await runs.saveRun(parent);
      await documents.putDocument(
        parent,
        'requirements',
        JSON.stringify({ prompt: 'x', plan: { items: ['x'], decision: 'approve' } }),
      );
      const task = {
        id: 'a',
        title: 'A',
        description: '',
        depends: [],
        files: [],
        proof: '',
        status: 'pending' as const,
      };

      const child = await app.get(RunSubtaskCommandsService).openSubtask(parent, task);

      expect(child.startedBy).toBe('alice');
    } finally {
      await app.close();
    }
  });
});
