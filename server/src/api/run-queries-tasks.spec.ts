import 'reflect-metadata';
import { storeRun } from '../testing/store-run.spec-helpers';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentCallRepository } from '../history/agent-call.repository';
import { seedCall } from '../history/agent-call.spec-helpers';
import { DocumentRepository } from '../history/document.repository';
import { writeRunState } from '../history/run-state';
import { RunRepository } from '../history/run.repository';
import { seededBoot } from './runs-boot.spec-helpers';
import { RunQueriesService } from './run-queries.service';
import { TASK_SECTION_KEYS } from './run-queries-tasks';

describe('RunQueriesService.tasks', () => {
  it('gives the task section of the run page of an epic with running tasks', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 2));
    const app = await seededBoot(await mkdtemp(join(tmpdir(), 'swarmloop-tasks-part-')));
    try {
      const runs = app.get(RunRepository);
      const parent = await runs.begin('proj-t1', 'implement');
      await storeRun(runs, parent);
      await seedCall(app.get(AgentCallRepository), { runKey: parent.key, usd: 2 });
      await app
        .get(DocumentRepository)
        .putDocument(
          parent,
          'requirements',
          JSON.stringify({ prompt: 'x', plan: { items: ['x'], decision: 'approve' } }),
        );
      const task = (id: string) => ({
        id,
        title: id,
        description: '',
        depends: [],
        files: [],
        proof: '',
        status: 'running',
      });
      await app.get(DocumentRepository).putDocument(parent, 'subtasks', JSON.stringify([task('a'), task('b')]));
      await app.get(DocumentRepository).putDocument(parent, 'contract', 'decisions:\n- subtask a: store UTC\n');
      for (const id of ['a', 'b']) {
        const child = await runs.openSubtask(`proj-t1-${id}`, parent.id, id);
        writeRunState(child, { status: 'running', currentStep: 'implement' });
        await storeRun(runs, child);
        await seedCall(app.get(AgentCallRepository), { runKey: child.key, usd: 1 });
      }

      const queries = app.get(RunQueriesService);
      const flow = await queries.flow('proj-t1');
      const section = await queries.tasks('proj-t1');

      expect(flow.tasks).toHaveLength(2);
      expect(flow.epic).toBeDefined();
      for (const name of TASK_SECTION_KEYS) {
        expect(section[name]).toEqual(flow[name]);
      }
      expect(Object.keys(section).every((name) => (TASK_SECTION_KEYS as readonly string[]).includes(name))).toBe(true);
    } finally {
      now.mockRestore();
      await app.close();
    }
  });
});
