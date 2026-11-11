import 'reflect-metadata';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import { StepEventLog } from '../../history/step-event.log';

import { PipelineService } from '../../pipeline/pipeline.service';

import * as delays from '../../core/delay';
import type { PipelineSnapshot } from '../../integrations/code-host/code-host';

import { shot, job, call, boot, fakeWait, seed } from './pipeline.step.spec-helpers';

const URL = 'https://gitlab.example/group/demo/-/pipelines/43099959586';
const LONG = 'PIPELINE_TIMEOUT_MS=1800000\n';

/** One run that still goes: `running` of its `total` jobs run. */
function going(running: number, total: number): PipelineSnapshot {
  const jobs = Array.from({ length: running }, (_, at) => job(at + 1, `job-${at + 1}`, false, 'running'));
  const run = { id: 43099959586, status: 'running', url: URL, jobs, total, queued: false };
  return { ...shot('running', jobs), id: run.id, url: URL, runs: [run] };
}

/** A run the host accepted and never started. */
function unstarted(): PipelineSnapshot {
  const run = { id: 43095845201, status: 'running', url: URL, jobs: [], total: 0, queued: true };
  return { ...shot('running', []), id: run.id, url: URL, runs: [run] };
}

describe('pipeline step waiting', () => {
  afterEach(() => jest.restoreAllMocks());

  it('says what it waits for each time the answer changes, not on identical polls', async () => {
    const clock = fakeWait();
    const answers = [going(2, 12), going(2, 12), going(2, 12), going(3, 12), shot('success', [])];
    const read = jest.fn(() => Promise.resolve({ snapshot: answers.shift() ?? null, httpCalls: [call('GET')] }));
    const app = await boot(
      await mkdtemp(join(tmpdir(), 'swarmloop-pipe-wait-')),
      read,
      jest.fn(),
      LONG,
      undefined,
      clock,
    );
    try {
      await seed(app, 'PROJ-410');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-410');
      expect(result.exitCode).toBe(0);
      const run = await app.get(RunRepository).findRun('PROJ-410');
      const { events } = await app.get(StepEventLog).page(run?.id ?? 0, { limit: 500 });
      const titles = events.flatMap((event) => (event.kind === 'activity.started' ? [event.title] : []));
      expect(titles.filter((title) => title.startsWith('waiting for'))).toEqual([
        'waiting for ci run 43099959586: 2 of 12 jobs running',
        'waiting for ci run 43099959586: 3 of 12 jobs running',
      ]);
    } finally {
      await app.close();
    }
  });

  it('ends blocked with CI_NOT_RUN for a run the host never started, without cancelling it', async () => {
    const clock = fakeWait();
    const read = jest.fn(() => Promise.resolve({ snapshot: unstarted(), httpCalls: [call('GET')] }));
    const cancel = jest.fn();
    const app = await boot(
      await mkdtemp(join(tmpdir(), 'swarmloop-pipe-stuck-')),
      read,
      jest.fn(),
      LONG,
      cancel,
      clock,
    );
    try {
      await seed(app, 'PROJ-411');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-411');
      expect(result.exitCode).toBe(1);
      const waited = jest.mocked(delays.delay).mock.calls.reduce((sum, item) => sum + item[0], 0);
      expect(waited).toBeLessThanOrEqual(180_000 + 15_000);
      expect(cancel).not.toHaveBeenCalled();
      expect((await app.get(RunRepository).findRun('PROJ-411'))?.status).toBe('blocked');
      const body = await app.get(DocumentRepository).latestBody('PROJ-411', 'pipeline_log');
      expect(body?.split('\n')[0]).toBe(`CI_NOT_RUN: CI host did not start run 43095845201 ${URL}`);
    } finally {
      await app.close();
    }
  });
});
