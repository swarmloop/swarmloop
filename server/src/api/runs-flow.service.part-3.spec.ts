import 'reflect-metadata';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { RunRepository } from '../history/run.repository';

import { VisitRepository } from '../history/visit.repository';

import { FlowRepository } from '../history/flow.repository';

import { LiveHub } from '../live/live.hub';

import { RunQueriesService } from './run-queries.service';

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
});
