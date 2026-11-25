import 'reflect-metadata';
import { storeRun } from '../testing/store-run.spec-helpers';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Clock } from '../core/clock';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { LiveHub } from '../live/live.hub';
import { PipelineService } from '../pipeline/pipeline.service';
import { save } from '../testing/runs.spec-helpers';
import { seededBoot } from './runs-boot.spec-helpers';
import { RunListRows } from './run-list-rows';
import { RunQueriesService } from './run-queries.service';
import { RunUsageReader } from './run-usage';

async function setup(prefix: string) {
  const app = await seededBoot(await mkdtemp(join(tmpdir(), prefix)));
  const runs = app.get(RunRepository);
  const hub = app.get(LiveHub);
  const reader = new RunUsageReader(runs, app.get(VisitRepository), app.get(PipelineService), app.get(Clock), hub);
  return { app, runs, hub, reader, queries: app.get(RunQueriesService) };
}

describe('RunUsageReader', () => {
  it('gives the same tokens, cost and peaks as the run page, with the open spend of a working run', async () => {
    const { app, runs, hub, reader, queries } = await setup('swarmloop-usage-');
    try {
      const run = await save(runs, 'proj-u1', 'implement', 'running');
      run.spentUsd = 1.5;
      await storeRun(runs, run);
      hub.log({
        key: 'proj-u1',
        step: 'implement',
        body: '',
        usage: { tokensIn: 100, tokensOut: 20, usd: 0.25 },
        samples: [{ at: '2026-01-01T00:00:00Z', cpu: 40, memory: 300, source: 'agent' }],
      });
      const { metrics } = await queries.flow('proj-u1');
      const [entry] = await reader.entries('proj-u1');
      expect(entry).toEqual({
        key: 'proj-u1',
        tokens: metrics.tokens,
        usd: metrics.usd,
        cpuPeak: metrics.cpuPeak,
        memPeak: metrics.memPeak,
      });
      expect(entry).toMatchObject({ tokens: 120, usd: 1.75, cpuPeak: 40, memPeak: 300 });
      const row = (await app.get(RunListRows).read()).view.runs.find((item) => item.key === 'proj-u1');
      expect(entry?.usd).toBe(row?.usd);
    } finally {
      await app.close();
    }
  });

  it('adds the epic total of a run with subtask runs, and the parent entry for a subtask', async () => {
    const { app, runs, reader, queries } = await setup('swarmloop-usage-epic-');
    try {
      const parent = await save(runs, 'proj-u2', 'implement', 'waiting');
      parent.split = true;
      parent.spentUsd = 2;
      await storeRun(runs, parent);
      await app.get(DocumentRepository).putDocument(parent, 'subtasks', `${JSON.stringify([{ id: 'a' }])}\n`);
      const child = await save(runs, 'proj-u2-a', 'implement', 'waiting');
      child.parentRunId = parent.id;
      child.taskId = 'a';
      child.spentUsd = 3;
      await storeRun(runs, child);

      const flow = await queries.flow('proj-u2');
      const [own] = await reader.entries('proj-u2');
      expect(own?.epic).toEqual(flow.epic);
      expect(own?.epic?.usd).toBe(5);

      const [task, up] = await reader.entries('proj-u2-a');
      expect(task).toMatchObject({ key: 'proj-u2-a', usd: 3 });
      expect(task?.epic).toBeUndefined();
      expect(up).toEqual(own);
    } finally {
      await app.close();
    }
  });

  it('gives nothing for a missing run', async () => {
    const { app, reader } = await setup('swarmloop-usage-none-');
    try {
      await expect(reader.entries('missing')).resolves.toEqual([]);
    } finally {
      await app.close();
    }
  });
});
