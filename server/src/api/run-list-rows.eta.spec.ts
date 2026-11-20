import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subtask } from '../contract/subtask';
import { SUBTASKS_KIND } from '../contract/subtask';
import { seedFor } from '../eta/seed';
import { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { freshView } from './run-list-rows.spec-helpers';
import { seededBoot } from './runs-boot.spec-helpers';

async function withApp(body: (app: Awaited<ReturnType<typeof seededBoot>>) => Promise<void>): Promise<void> {
  const app = await seededBoot(await mkdtemp(join(tmpdir(), 'swarmloop-run-list-eta-')));
  try {
    await body(app);
  } finally {
    await app.close();
  }
}

async function runningRun(
  app: Awaited<ReturnType<typeof seededBoot>>,
  open: () => Promise<RunEntity>,
  status = 'running',
): Promise<RunEntity> {
  const run = await open();
  writeRunState(run, { status, currentStep: 'implement' });
  return app.get(RunRepository).saveRun(run);
}

const task = (id: string, depends: string[], status: Subtask['status']): Subtask => ({
  id,
  title: `Task ${id}`,
  description: '',
  depends,
  files: [],
  proof: '',
  status,
});

describe('run list eta', () => {
  it('gives a working run the seed estimate, and a run that waits for answers or is done none', () =>
    withApp(async (app) => {
      const runs = app.get(RunRepository);
      await runningRun(app, () => runs.openWaiting('working-1', '/target'));
      await runningRun(app, () => runs.openWaiting('done-1', '/target'), 'done');
      const asking = await runs.openWaiting('asking-1', '/target');
      writeRunState(asking, { status: 'waiting', currentStep: 'research' });
      await runs.saveRun(asking);
      await app.get(DocumentRepository).putDocument(asking, 'questions', '- Which branch?\n');

      const rows = new Map((await freshView(app)).runs.map((row) => [row.key, row]));
      const eta = rows.get('working-1')?.eta;
      expect(eta?.leftMs).toBe(seedFor('implement'));
      expect(Date.parse(eta?.doneAt ?? '')).toBeGreaterThan(Date.now());
      expect(rows.get('asking-1')?.state).toBe('waiting');
      expect(rows.get('asking-1')?.eta).toEqual({ leftMs: null, doneAt: null });
      expect(rows.get('done-1')?.eta).toBeUndefined();
    }));

  it('gives an epic parent the estimate of its tasks, and it falls when a task merges', () =>
    withApp(async (app) => {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const parent = await runningRun(app, () => runs.openWaiting('epic-1', '/target'));
      const plan = (first: Subtask['status']) => JSON.stringify([task('a', [], first), task('b', ['a'], 'running')]);
      await documents.putDocument(parent, SUBTASKS_KIND, plan('running'));
      await runningRun(app, async () => runs.openSubtask('epic-1-a', parent.id, 'a'));
      await runningRun(app, async () => runs.openSubtask('epic-1-b', parent.id, 'b'));
      const etaOf = async () => (await freshView(app)).runs.find((row) => row.key === 'epic-1')?.eta?.leftMs ?? 0;

      const before = await etaOf();
      expect(before).toBeGreaterThan(2 * seedFor('implement'));

      await documents.putDocument(parent, SUBTASKS_KIND, plan('merged'));
      expect(before - (await etaOf())).toBe(seedFor('implement'));
    }));
});
