import 'reflect-metadata';
import { parseSubtasks, type Subtask } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { CommandService } from '../pipeline/command.service';
import { RunRepository } from '../history/run.repository';
import { deriveState, writeRunState } from '../history/run-state';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { installScripts } from '../pipeline/run-driver.spec-helpers';
import { save } from './runs.spec-helpers';
import type { TestApp } from './test-app';

const KEY = 'PROJ-420';

const task = (id: string, depends: string[] = []): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends,
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

const tasksOf = async (app: TestApp) =>
  parseSubtasks(await app.app.get(DocumentRepository).latestBody(KEY, 'subtasks'));

const statuses = async (app: TestApp) => Object.fromEntries((await tasksOf(app)).map((item) => [item.id, item.status]));

/** The subtask run ends in `status`; a `done` one has a merge request with green CI. */
async function end(app: TestApp, id: string, status: 'done' | 'blocked', iid = 0): Promise<void> {
  const runs = app.app.get(RunRepository);
  const run = (await runs.findRun(`${KEY}-${id}`))!;
  if (status === 'done') {
    const documents = app.app.get(DocumentRepository);
    await documents.putDocument(run, 'requirements', requirements);
    await documents.putDocument(run, 'repos', 'demo\n');
    const record = { project: 'demo', iid, url: `https://code.example/demo/${iid}`, draft: false, summary: '' };
    await documents.putDocument(run, 'merge_request', renderMergeRequest([record]));
    writeRunState(run, { status: 'done', currentStep: 'done' });
  } else {
    writeRunState(run, {
      status: 'blocked',
      currentStep: 'research',
      reason: { code: 'LOOP_LIMIT', message: 'checks ran 3 times (MAX_RETURNS); Resume starts another round' },
    });
  }
  await runs.saveRun(run);
}

describe('one blocked task holds only its dependents', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY);
    const runs = flow.app.app.get(RunRepository);
    const documents = flow.app.app.get(DocumentRepository);
    const parent = await save(runs, KEY, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    await runs.saveRun(parent);
    await documents.putDocument(parent, 'requirements', requirements);
    await documents.putDocument(parent, 'repos', 'demo\n');
    const tasks = [task('a'), task('b', ['a']), task('c'), task('d'), task('e')];
    await documents.putDocument(parent, 'subtasks', `${JSON.stringify(tasks)}\n`);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('merges a green task, starts an independent one, names the blocked task, and ends done after a fix', async () => {
    const { app } = flow;
    await app.pipeline.step('implement', KEY);
    expect(await statuses(app)).toEqual({ a: 'running', b: 'waiting', c: 'running', d: 'running', e: 'waiting' });

    await end(app, 'a', 'blocked');
    await end(app, 'c', 'done', 1);
    await app.pipeline.step('implement', KEY);
    await assertInvariants(app);

    expect(await statuses(app)).toEqual({ a: 'blocked', b: 'waiting', c: 'merged', d: 'running', e: 'running' });
    const state = deriveState((await app.app.get(RunRepository).findRun(KEY))!);
    expect(state.state).toBe('waiting');
    expect(state.reason?.message).toContain('subtask a is blocked; Resume, Replay or Skip task clears it');
    expect((await tasksOf(app))[1]?.note).toBe('waiting for a, which is blocked');

    await end(app, 'a', 'done', 2);
    await end(app, 'd', 'done', 3);
    await end(app, 'e', 'done', 4);
    await app.pipeline.step('implement', KEY);
    await end(app, 'b', 'done', 5);
    await app.pipeline.step('implement', KEY);

    expect(await statuses(app)).toEqual({ a: 'merged', b: 'merged', c: 'merged', d: 'merged', e: 'merged' });
    expect((await app.app.get(RunRepository).findRun(KEY))?.currentStep).toBe('checks');
  });

  it('Resume of the blocked task runs a parent pass at once, and a green sibling merges in it', async () => {
    const { app } = flow;
    const runs = app.app.get(RunRepository);
    const parent = (await runs.findRun(KEY))!;
    await app.app
      .get(DocumentRepository)
      .putDocument(parent, 'subtasks', `${JSON.stringify([task('a'), task('c')])}\n`);
    await app.pipeline.step('implement', KEY);
    await end(app, 'a', 'blocked');
    await app.pipeline.step('implement', KEY);
    expect(deriveState((await runs.findRun(KEY))!).state).toBe('waiting');
    await end(app, 'c', 'done', 1);
    await app.pipeline.step('implement', KEY);
    expect(deriveState((await runs.findRun(KEY))!).state).toBe('blocked');

    let during: Record<string, string> = {};
    installScripts(
      app,
      {
        research: async () => {
          await app.app.get(CommandService).idle();
          await app.pipeline.whenIdle(KEY);
          during = await statuses(app);
          return { outcome: 'waiting', exitCode: 0 };
        },
      },
      ['research'],
    );
    await app.pipeline.runThrough(`${KEY}-a`);

    expect(during.c).toBe('merged');
    expect(during.a).toBe('running');
  });
});
