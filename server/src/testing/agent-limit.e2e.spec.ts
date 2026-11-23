import 'reflect-metadata';
import { join } from 'path';
import { CommandService } from '../pipeline/command.service';
import { parseSubtasks, type Subtask } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { ContainerGate } from '../sandbox/container-gate';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { RunQueriesService } from '../api/run-queries.service';
import { planFields, withPlan } from '../steps/plan/plan-record';
import { git, save } from './runs.spec-helpers';
import { createFlowHarness } from './flow-harness';
import { GatedAgents } from './gated-agent.spec-helpers';
import type { TestApp } from './test-app';

const PARENTS = ['PROJ-501', 'PROJ-502'];
const IDS = ['a', 'b', 'c'];

const task = (id: string): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

const requirements = (key: string) =>
  `${JSON.stringify({
    prompt: 'Ship the field\n',
    tickets: [{ key, summary: 'Ship the field' }],
    plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
  })}\n`;

/** A split run with 3 independent tasks, waiting at implement for the parent pass to start them. */
async function splitRun(app: TestApp, key: string): Promise<void> {
  const runs = app.app.get(RunRepository);
  const documents = app.app.get(DocumentRepository);
  const parent = await save(runs, key, 'implement', 'waiting');
  parent.split = true;
  parent.projects = 'demo\n';
  await runs.saveRun(parent);
  await documents.putDocument(parent, 'requirements', requirements(key));
  await documents.putDocument(parent, 'repos', 'demo\n');
  await documents.putDocument(parent, 'subtasks', `${JSON.stringify(IDS.map(task))}\n`);
}

/** The subtask run has the approved plan one checklist item long, as its implement step starts from. */
async function planned(app: TestApp, key: string): Promise<void> {
  const documents = app.app.get(DocumentRepository);
  const run = (await app.app.get(RunRepository).findRun(key))!;
  const plan = { ...planFields(['add the field']), decision: 'approve' as const };
  await documents.putDocument(run, 'requirements', withPlan(requirements(key), plan));
  await documents.putDocument(run, 'repos', 'demo\n');
  git(join(app.root, 'demo'), [
    'worktree',
    'add',
    '-b',
    `feature/${key}-ship-the-field`,
    join(app.root, 'worktrees', key, 'demo'),
    'main',
  ]);
}

/** The subtask run ends with a merge request that has green CI, which the next pass of its parent merges. */
async function finish(app: TestApp, key: string, iid: number): Promise<void> {
  const runs = app.app.get(RunRepository);
  const documents = app.app.get(DocumentRepository);
  const run = (await runs.findRun(key))!;
  await documents.putDocument(run, 'requirements', requirements(key));
  await documents.putDocument(run, 'repos', 'demo\n');
  const record = { project: 'demo', iid, url: `https://code.example/demo/${iid}`, draft: false, summary: '' };
  await documents.putDocument(run, 'merge_request', renderMergeRequest([record]));
  writeRunState(run, { status: 'done', currentStep: 'done' });
  await runs.saveRun(run);
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('one limit on agents for the whole server', () => {
  it('two split runs of 3 subtasks never run more than 4 agent containers at once, and both finish', async () => {
    const agents = new GatedAgents();
    const flow = await createFlowHarness(PARENTS[0], { env: { AGENTS_PARALLEL: '4' }, runner: agents });
    const { app } = flow;
    try {
      flow.fastWaits();
      const gate = app.app.get(ContainerGate);
      agents.through(gate);
      const second = PARENTS[1];
      git(join(app.root, 'demo'), [
        'worktree',
        'add',
        '-b',
        `feature/${second}-ship-the-field`,
        join(app.root, 'worktrees', second, 'demo'),
        'main',
      ]);
      for (const key of PARENTS) await splitRun(app, key);
      for (const key of PARENTS) await app.pipeline.step('implement', key);
      await app.app.get(CommandService).idle();
      expect(flow.launched).toHaveLength(6);

      // The 6 subtask runs go through their own implement step; each launch of its agent takes a place in the gate.
      for (const key of flow.launched) await planned(app, key);
      const steps = flow.launched.map((key) => app.pipeline.step('implement', key));
      while (agents.waited.length < 2) await flush();
      expect(agents.open).toBe(4);

      const waiting = flow.launched.find((key) => gate.agentWait(key).steps.length > 0) as string;
      const listed = (await app.app.get(RunQueriesService).list()).runs.find((run) => run.key === waiting);
      expect(listed?.state).toBe('running');
      expect(listed?.stateReason?.message).toBe('Waiting for a free agent place (4 of 4 busy)');

      while (agents.endOldest()) await flush();
      agents.endAll();
      await Promise.all(steps);
      expect(agents.peak).toBe(4);
      expect(agents.waited.length).toBeGreaterThan(0);

      let iid = 0;
      for (const key of flow.launched) await finish(app, key, (iid += 1));
      for (const key of PARENTS) {
        await app.pipeline.step('implement', key);
        const tasks = parseSubtasks(await app.app.get(DocumentRepository).latestBody(key, 'subtasks'));
        expect(tasks.map((item) => item.status)).toEqual(['merged', 'merged', 'merged']);
        for (const step of ['checks', 'code-review', 'commit', 'merge-request', 'pipeline'] as const) {
          await app.pipeline.step(step, key);
        }
        expect((await app.app.get(RunRepository).findRun(key))?.currentStep).toBe('done');
      }
    } finally {
      agents.endAll();
      jest.restoreAllMocks();
      await flow.close();
    }
  });
});
