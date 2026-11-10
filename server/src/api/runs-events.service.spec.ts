import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StepEvent } from '../contract/step-events';
import { RunRepository } from '../history/run.repository';
import { StepEventLog } from '../history/step-event.log';
import { boot, save } from '../testing/runs.spec-helpers';
import { RunQueriesService } from './run-queries.service';

function event(runId: number, seq: number, step: StepEvent['step']): StepEvent {
  return {
    payloadVersion: 1,
    eventId: `event-${seq}`,
    runId,
    attemptId: 'attempt-1',
    step,
    seq,
    occurredAt: '2026-01-01T00:00:00.000Z',
    parentSpanId: null,
    kind: 'attempt.finished',
    route: 'ok',
    summary: 'done',
  };
}

describe('run events api', () => {
  it('pages the events of a run, newest last, and rejects what it cannot read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-events-'));
    const app = await boot(root);
    try {
      const run = await save(app.get(RunRepository), 'proj-7', 'commit', 'waiting');
      await app
        .get(StepEventLog)
        .append([event(run.id, 1, 'branch'), event(run.id, 2, 'commit'), event(run.id, 3, 'commit')]);
      const queries = app.get(RunQueriesService);
      const all = await queries.stepEventPage('proj-7', {});
      expect(all.events.map(({ seq }) => seq)).toEqual([1, 2, 3]);
      expect(all.next).toBeNull();
      const page = await queries.stepEventPage('proj-7', { step: 'commit', after: '1', limit: '1' });
      expect(page.events.map(({ seq }) => seq)).toEqual([2]);
      expect(page.next).toBe(2);
      await expect(queries.stepEventPage('missing', {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(queries.stepEventPage('proj-7', { limit: 'many' })).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('gives a step view its descriptor and the last event seq of the run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-events-'));
    const app = await boot(root);
    try {
      const run = await save(app.get(RunRepository), 'proj-8', 'commit', 'waiting');
      const queries = app.get(RunQueriesService);
      const before = await queries.step('proj-8', 'implement');
      expect(before.eventsCursor).toBe(0);
      expect(before.descriptor.name).toBe('implement');
      expect(before.descriptor.kind).toBe('agent');
      expect(before.descriptor.agent?.model).toBeTruthy();
      expect(before.descriptor.agent).toMatchObject({ role: 'implement', tier: 'main' });
      await app.get(StepEventLog).append([event(run.id, 1, 'commit'), event(run.id, 2, 'commit')]);
      expect((await queries.step('proj-8', 'commit')).eventsCursor).toBe(2);
      const reviewer = await queries.step('proj-8', 'code-review-quality');
      expect(reviewer.descriptor.name).toBe('code-review');
      expect(reviewer.descriptor.reviewers?.length).toBeGreaterThan(0);
      expect(reviewer.descriptor.agent).toMatchObject({ role: 'review', tier: 'main' });
      expect((await queries.step('proj-8', 'done')).descriptor).toEqual({ name: 'done', kind: 'server' });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
