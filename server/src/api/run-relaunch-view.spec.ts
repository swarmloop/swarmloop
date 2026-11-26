import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { STEPS } from '../contract/steps';
import { SEED_RUN_MS, seedFor } from '../eta/seed';
import { DocumentRepository } from '../history/document.repository';
import { FlowRepository } from '../history/flow.repository';
import { writeRunState } from '../history/run-state';
import { RunRepository } from '../history/run.repository';
import { mergeHandoff } from '../steps/shared/handoff';
import { freshView } from './run-list-rows.spec-helpers';
import { RunQueriesService } from './run-queries.service';
import { seededBoot } from './runs-boot.spec-helpers';

const NOTE = 'rebased onto the epic after input merged';

/** A subtask waiting at checks, relaunched there by a rebase whose reason its handoff holds. */
async function relaunchedSubtask(app: Awaited<ReturnType<typeof seededBoot>>, key: string): Promise<void> {
  const runs = app.get(RunRepository);
  const parent = await runs.begin(`${key}-epic`, 'implement');
  const run = await runs.openSubtask(key, parent.id, 'a');
  await runs.change(key, (next) => writeRunState(next, { status: 'running', currentStep: 'checks' }));
  await app.get(DocumentRepository).putDocument(run, 'handoff', mergeHandoff(null, 'rebase', NOTE));
  const flows = app.get(FlowRepository);
  await flows.noteFlow(key, ['planning'], null);
  await flows.noteFlow(key, ['checks', 'ci'], 'checks', 'rebase');
}

describe('the run view of a rebased run', () => {
  it('shows one relaunch in the run page and the history, with its steps waiting to run', async () => {
    const app = await seededBoot(await mkdtemp(join(tmpdir(), 'swarmloop-relaunch-view-')));
    try {
      await relaunchedSubtask(app, 'proj-r1');
      const queries = app.get(RunQueriesService);
      const expected = {
        reason: 'Rebased onto the epic after input merged',
        phases: ['checks', 'ci'],
        steps: ['checks', 'commit', 'merge-request', 'pipeline'],
        open: true,
      };
      const flow = await queries.flow('proj-r1');
      expect(flow.relaunches).toEqual([expect.objectContaining(expected)]);
      const statuses = Object.fromEntries(flow.phases.flatMap((phase) => phase.steps).map((s) => [s.name, s.status]));
      expect(statuses).toMatchObject({ commit: 'idle', 'merge-request': 'idle', pipeline: 'idle' });
      expect(flow.returns).toEqual([]);
      const history = await queries.readHistory('proj-r1');
      expect(history.relaunches).toEqual([expect.objectContaining(expected)]);
      expect(history.launches).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('gives the run list the time of the steps a relaunch runs, and a run without one the same as before', async () => {
    const app = await seededBoot(await mkdtemp(join(tmpdir(), 'swarmloop-relaunch-list-')));
    try {
      await relaunchedSubtask(app, 'proj-r2');
      const runs = app.get(RunRepository);
      const plain = await runs.openWaiting('proj-r3', '/target');
      await runs.change(plain.key, (next) => writeRunState(next, { status: 'running', currentStep: 'checks' }));
      const rows = new Map((await freshView(app)).runs.map((row) => [row.key, row]));
      expect(rows.get('proj-r2')?.eta?.leftMs).toBe((4 * SEED_RUN_MS) / STEPS.length);
      expect(rows.get('proj-r3')?.eta?.leftMs).toBe(seedFor('checks'));
    } finally {
      await app.close();
    }
  });
});
