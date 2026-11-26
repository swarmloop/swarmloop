import { storeRun } from '../testing/store-run.spec-helpers';
import type { TestingModule } from '@nestjs/testing';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import type { Subtask } from '../contract/subtask';
import { SUBTASKS_KIND } from '../contract/subtask';
import { BacklogRepository } from '../history/backlog.repository';
import { CommandRepository } from '../history/command.repository';
import { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import { FlowRepository } from '../history/flow.repository';
import { VisitRepository } from '../history/visit.repository';
import { RunRepository } from '../history/run.repository';
import { RunWaitLog } from '../history/run-wait.log';
import { writeRunState } from '../history/run-state';
import { LiveHub } from '../live/live.hub';
import { PipelineService } from '../pipeline/pipeline.service';
import { EtaSummary } from './eta-summary';
import { RunListRows } from './run-list-rows';

/** The run list as a freshly constructed `RunListRows` reads it: every row built from the database. */
export async function freshView(app: TestingModule) {
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
    app.get(LiveHub),
  );
  try {
    return (await rows.read()).view;
  } finally {
    rows.onModuleDestroy();
  }
}

function task(id: string, note?: string): Subtask {
  return { id, title: `Task ${id}`, description: '', depends: [], files: [], proof: '', status: 'pending', note };
}

/** The ids of the runs `seedRuns` makes. */
export const SEEDED = {
  parent: 'epic-1',
  done: 'epic-1-a',
  open: 'epic-1-b',
  untitled: 'untitled-1',
  plain: 'plain-1',
};

/** `total` waiting runs: a parent with a plan and two subtasks (one done, waiting for its merge), an untitled run with requirements, and plain runs. */
export async function seedRuns(app: TestingModule, total: number): Promise<void> {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const parent = await runs.openWaiting(SEEDED.parent, '/target');
  await documents.putDocument(parent, SUBTASKS_KIND, JSON.stringify([task('a', 'waits for b'), task('b')]));
  const done = await runs.openSubtask(SEEDED.done, parent.id, 'a');
  writeRunState(done, { status: 'done', currentStep: 'commit' });
  await storeRun(runs, done);
  await runs.openSubtask(SEEDED.open, parent.id, 'b');
  const untitled = await runs.openWaiting(SEEDED.untitled, '/target');
  await documents.putDocument(
    untitled,
    'requirements',
    `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [], epic: null, epics: [], files: [], pages: [] })}\n`,
  );
  for (let n = 1; n <= total - 4; n++) {
    await runs.openWaiting(`plain-${n}`, '/target');
  }
}

export async function runOf(app: TestingModule, key: string): Promise<RunEntity> {
  return (await app.get(RunRepository).findRun(key)) as RunEntity;
}
