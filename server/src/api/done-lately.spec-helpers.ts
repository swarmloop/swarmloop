import type { TestingModule } from '@nestjs/testing';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { AgentCallRepository } from '../history/agent-call.repository';
import { seedCall } from '../history/agent-call.spec-helpers';
import { BacklogRepository } from '../history/backlog.repository';
import { CommandRepository } from '../history/command.repository';
import { DocumentRepository } from '../history/document.repository';
import { FlowRepository } from '../history/flow.repository';
import { RunRepository } from '../history/run.repository';
import { RunWaitLog } from '../history/run-wait.log';
import { writeRunState } from '../history/run-state';
import { VisitRepository } from '../history/visit.repository';
import { LiveHub } from '../live/live.hub';
import { BacklogQueries } from '../pipeline/backlog/backlog-queries';
import { PipelineService } from '../pipeline/pipeline.service';
import { storeRun } from '../testing/store-run.spec-helpers';
import { DoneLatelyService } from './done-lately.service';
import { EtaSummary } from './eta-summary';
import { RunListRows } from './run-list-rows';

/** What a seeded finished run holds. `usd` lands as one row of the log under the run's key. */
export interface FinishedRun {
  /** The merge time; the run is a merged one. */
  at: string;
  createdAt?: string;
  updatedAt?: string;
  usd?: number;
  /** The key of the parent run: the run is one of its subtasks. */
  parent?: string;
}

/** Stores a merged run, as the pipeline leaves it, and the row of the log that holds its cost. */
export async function seedFinished(app: TestingModule, key: string, finished: FinishedRun): Promise<void> {
  const runs = app.get(RunRepository);
  const parent = finished.parent === undefined ? null : await runs.findRun(finished.parent);
  const run = parent ? await runs.openSubtask(key, parent.id, key) : await runs.openWaiting(key, '/target');
  writeRunState(run, {
    status: 'done',
    currentStep: 'commit',
    merge: { merged: { shop: { sha: null, by: null, at: finished.at, url: null } } },
  });
  if (finished.createdAt) run.createdAt = finished.createdAt;
  if (finished.updatedAt) run.updatedAt = finished.updatedAt;
  await storeRun(runs, run);
  if (finished.usd) await seedCall(app.get(AgentCallRepository), { runKey: key, usd: finished.usd });
}

let position = 0;

/** An accepted milestone of a backlog whose tasks each hold one of the run keys. */
export async function seedAcceptedMilestone(
  app: TestingModule,
  backlog: string,
  number: number,
  runKeys: string[],
): Promise<void> {
  const backlogs = app.get(BacklogRepository);
  const at = '2026-01-01T00:00:00.000Z';
  const saved =
    (await backlogs.findBacklog(backlog)) ??
    (await backlogs.saveBacklog({
      name: backlog,
      owner: 'ada',
      repositories: ['shop'],
      mergeMode: 'green',
      paused: false,
      createdAt: at,
    }));
  const milestone = await backlogs.saveMilestone({
    backlogId: saved.id as number,
    number,
    title: 'Checkout',
    goal: '',
    status: 'accepted',
    createdAt: at,
  });
  for (const runKey of runKeys) {
    position += 1;
    await backlogs.saveTask({
      backlogId: saved.id as number,
      milestoneId: milestone.id as number,
      slug: `task-${position}`,
      title: runKey,
      description: '',
      repositories: ['shop'],
      covers: [],
      depends: [],
      files: [],
      proof: [],
      manual: false,
      fixesMain: null,
      status: 'merged',
      runKey,
      note: '',
      runNow: false,
      mergeOk: false,
      merged: {},
      madeBy: 'person',
      position,
      createdAt: at,
    });
  }
}

/** A `DoneLatelyService` built by hand over the app's repositories, with a fresh `RunListRows`. Call `close` when done. */
export function doneLately(app: TestingModule): { service: DoneLatelyService; close: () => void } {
  const rows = new RunListRows(
    app.get(RunRepository),
    app.get(DocumentRepository),
    app.get(CommandRepository),
    app.get(BacklogRepository),
    app.get(PipelineService),
    app.get(Clock),
    app.get(EtaSummary),
    app.get(RunWaitLog),
    app.get(FlowRepository),
    app.get(VisitRepository),
    app.get(AppConfig),
    app.get(AgentCallRepository),
    app.get(LiveHub),
  );
  const queries = new BacklogQueries(app.get(BacklogRepository), app.get(RunRepository));
  return {
    service: new DoneLatelyService(rows, queries, app.get(AgentCallRepository)),
    close: () => rows.onModuleDestroy(),
  };
}

/**
 * A list of `total` finished runs: one created first that finished last, an epic with two subtasks, an accepted
 * milestone of three tasks, and plain runs that finished earlier. The log holds a row for each run that costs.
 */
export async function seedFinishedList(app: TestingModule, total: number): Promise<void> {
  await seedFinished(app, 'created-first', {
    at: '2026-03-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    usd: 9,
  });
  await seedFinished(app, 'epic-1', { at: '2026-02-10T00:00:00.000Z', usd: 1 });
  await seedFinished(app, 'epic-1-a', { at: '2026-02-09T00:00:00.000Z', parent: 'epic-1', usd: 2 });
  await seedFinished(app, 'epic-1-b', { at: '2026-02-09T00:00:00.000Z', parent: 'epic-1', usd: 3 });
  const tasks = [
    ['task-a', '06:00', '08:00', 1],
    ['task-b', '07:00', '10:00', 2],
    ['task-c', '07:30', '12:00', 4],
  ] as const;
  for (const [key, created, merged, usd] of tasks) {
    await seedFinished(app, key, {
      at: `2026-02-20T${merged}:00.000Z`,
      createdAt: `2026-02-20T${created}:00.000Z`,
      usd,
    });
  }
  await seedAcceptedMilestone(
    app,
    'shop',
    1,
    tasks.map(([key]) => key),
  );
  for (let n = 1; n <= total - 7; n++) {
    await seedFinished(app, `plain-${n}`, {
      at: '2026-01-01T00:00:00.000Z',
      createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + n * 60_000).toISOString(),
      usd: 0.5,
    });
  }
}
