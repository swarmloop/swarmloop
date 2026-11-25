import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { PlanChatService } from '../api/plan-chat.service';
import { parseSubtasks } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { PlannerTurns } from '../pipeline/planner-turns';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { createFlowHarness } from './flow-harness';
import { remember } from './runs.spec-helpers';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import type { TestApp } from './test-app';

const KEY = 'PROJ-800';
const REQUESTS = [{ id: 'R1', text: 'ship the field' }];

const split = (id: string, depends: string[] = []) => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends,
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  covers: ['R1'],
});
const FIRST = [split('a'), split('b'), split('c', ['a'])];
const NEW = split('d', ['c']);

const block = (value: unknown): ScriptedAnswer => ({ block: value });
const planned = block({
  summary: ['planned'],
  contract: [{ id: 'item-1', text: 'store UTC', owner: 'a' }],
  tasks: FIRST,
  keep: [],
});
const improved = block({
  summary: ['checked'],
  contract: [{ id: 'item-1', text: 'store UTC', owner: 'a' }],
  tasks: FIRST,
  keep: [],
});
const withD = [...FIRST, NEW];
const improvedWithD = block({
  summary: ['checked'],
  contract: [
    { id: 'item-1', text: 'store UTC', owner: 'a' },
    { id: 'item-2', text: 'd uses c', owner: 'a' },
  ],
  tasks: withD,
  keep: [],
});
const adds = block({
  reply: 'Added d.',
  summary: ['d'],
  contract: [{ id: 'item-1', text: 'd uses c', owner: 'a' }],
  tasks: [NEW],
  keep: [],
});

describe('a person writes to the planner of a split run after its tasks started', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  async function start(scripts: Record<string, ScriptedAnswer[]>): Promise<void> {
    blocks = new BlockAgentRunner({
      plan: [planned, ...(scripts.plan ?? [])],
      'plan-improve': [improved, ...(scripts.improve ?? [])],
    });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all' });
    const run = await remember(
      flow.app.app.get(RunRepository),
      flow.app.app.get(DocumentRepository),
      KEY,
      'plan',
      'waiting',
    );
    run.codeHost = 'gitlab';
    run.split = true;
    run.projects = 'demo\n';
    await storeRun(flow.app.app.get(RunRepository), run);
    await flow.app.app.get(DocumentRepository).putDocument(run, 'requirement_list', `${JSON.stringify(REQUESTS)}\n`);
    for (const step of ['plan', 'plan-improve', 'branch', 'implement'] as const) {
      await flow.app.pipeline.step(step, KEY);
    }
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const app = (): TestApp => flow.app;
  const store = () => app().app.get(PlanChatStore);
  const runOf = () => app().app.get(RunRepository).findRun(KEY);
  const tasks = async () => parseSubtasks(await app().app.get(DocumentRepository).latestBody(KEY, 'subtasks'));
  const statuses = async () => Object.fromEntries((await tasks()).map((task) => [task.id, task.status]));
  const message = (text: string) =>
    store().appendEntry(KEY, {
      key: 'message-1',
      role: 'person',
      author: 'ana',
      text,
      at: new Date(app().clock.now()).toISOString(),
      state: 'pending',
    });

  it('asks for added tasks only, and the new task joins the scheduler while the started tasks stay', async () => {
    await start({ plan: [adds], improve: [improvedWithD] });
    expect(await statuses()).toMatchObject({ a: 'running', b: 'running' });
    app().clock.advance(1000);
    await message('Also add d');

    await app().pipeline.runThrough(KEY, { auto: true });

    const ask = blocks.prompts.filter((launch) => launch.step === 'plan').at(-1)?.prompt ?? '';
    expect(ask).toContain('give only the tasks to add');
    expect(ask).toContain('Only the tasks to add');
    expect(await store().pending(KEY)).toEqual([]);
    expect(await tasks()).toMatchObject([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'running' },
      { id: 'c', status: 'waiting' },
      { id: 'd', depends: ['c'], status: 'waiting' },
    ]);
    expect(await app().app.get(RunRepository).findRun(`${KEY}-d`)).not.toBeNull();
    expect((await runOf())?.currentStep).toBe('implement');
    expect((await store().read(KEY)).revisions).toMatchObject([
      { added: ['Task d - files: src/d.ts - proof: d.spec.ts'] },
    ]);
  });

  it('refuses a plan-improve answer that rewrites a started task and asks again', async () => {
    const rewritten = block({
      summary: ['checked'],
      contract: [
        { id: 'item-1', text: 'store UTC', owner: 'a' },
        { id: 'item-2', text: 'd uses c', owner: 'a' },
      ],
      tasks: [{ ...FIRST[0], title: 'Another title' }, ...withD.slice(1)],
      keep: [],
    });
    await start({ plan: [adds], improve: [rewritten, improvedWithD] });
    app().clock.advance(1000);
    await message('Also add d');

    await app().pipeline.runThrough(KEY, { auto: true });

    const asked = blocks.prompts.filter((launch) => launch.step === 'plan-improve');
    expect(asked).toHaveLength(3);
    expect(asked[2].prompt).toContain('task a already started and cannot be changed (title)');
    expect((await tasks()).find((task) => task.id === 'a')).toMatchObject({ title: 'Task a', status: 'running' });
    expect((await tasks()).map((task) => task.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the tasks and goes on for a reply without tasks', async () => {
    await start({ plan: [block({ reply: 'Task c covers that.' })] });
    app().clock.advance(1000);
    await message('Is the empty case covered?');

    await app().pipeline.runThrough(KEY, { auto: true });

    expect(blocks.steps.filter((step) => step === 'plan-improve')).toHaveLength(1);
    expect(await store().pending(KEY)).toEqual([]);
    expect((await tasks()).map((task) => task.id)).toEqual(['a', 'b', 'c']);
    expect((await store().read(KEY)).revisions).toEqual([]);
  });

  it('reopens a done run with an open merge request for a reply that adds tasks, and it is done again after the new task', async () => {
    await start({ plan: [adds], improve: [improvedWithD] });
    const run = (await runOf())!;
    const documents = app().app.get(DocumentRepository);
    const merged = (await tasks()).map((task) => ({ ...task, status: 'merged' as const }));
    await documents.putDocument(run, 'subtasks', `${JSON.stringify(merged)}\n`);
    // The parent already looked at each merged task.
    const looked = merged.map((task) => ({ task: task.id, marks: [], at: '2026-01-01T00:00:00.000Z' }));
    await documents.putDocument(run, 'merge_look', JSON.stringify(looked));
    const { record } = await flow.host.openMergeRequest({
      project: 'group/demo',
      source: `feature/${KEY}-ship-the-field`,
      target: 'main',
      title: 'Ship the field',
      summary: '',
      draft: false,
    });
    await documents.putDocument(run, 'merge_request', renderMergeRequest([record]));
    writeRunState(run, { status: 'done', currentStep: 'done' });
    await storeRun(app().app.get(RunRepository), run);
    app().clock.advance(1000);

    await app().app.get(PlanChatService).send(KEY, 'Also add d', 'ana');
    await app().app.get(PlannerTurns).idle();
    await app().pipeline.whenIdle(KEY);

    expect(await documents.latestBody(KEY, 'merge_request')).toContain('draft: true');
    expect(blocks.steps.slice(-2)).toEqual(['plan', 'plan-improve']);
    expect(await statuses()).toMatchObject({ a: 'merged', b: 'merged', c: 'merged' });
    expect((await tasks()).map((task) => task.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(await app().app.get(RunRepository).findRun(`${KEY}-d`)).not.toBeNull();
    expect((await runOf())?.currentStep).toBe('implement');

    const child = (await app().app.get(RunRepository).findRun(`${KEY}-d`))!;
    const { record: forD } = await flow.host.openMergeRequest({
      project: 'group/demo',
      source: `feature/${KEY}-d`,
      target: `feature/${KEY}-ship-the-field`,
      title: 'Task d',
      summary: '',
      draft: false,
    });
    await documents.putDocument(child, 'requirements', (await documents.latestBody(KEY, 'requirements')) ?? '');
    await documents.putDocument(child, 'repos', 'demo\n');
    await documents.putDocument(child, 'merge_request', renderMergeRequest([forD]));
    writeRunState(child, { status: 'done', currentStep: 'done' });
    await storeRun(app().app.get(RunRepository), child);
    await app().pipeline.step('implement', KEY);
    for (const step of ['checks', 'code-review', 'commit', 'merge-request', 'pipeline'] as const) {
      await app().pipeline.step(step, KEY);
    }

    expect(await statuses()).toEqual({ a: 'merged', b: 'merged', c: 'merged', d: 'merged' });
    expect((await runOf())?.currentStep).toBe('done');
  });
});
