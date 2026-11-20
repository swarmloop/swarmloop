import 'reflect-metadata';
import { parseSubtasks, type Subtask } from '../contract/subtask';
import { readPlanChat } from '../contract/plan-chat';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { RunQueriesService } from '../api/run-queries.service';
import { CommandService } from '../pipeline/command.service';
import { SubtaskPlannerAnswer } from '../pipeline/subtask-planner-answer';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { StarterBriefing } from '../steps/shared/starter-briefing';
import { InputReader } from '../steps/contract/input-reader';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { readContract } from '../steps/shared/contract-items';
import { createFlowHarness } from './flow-harness';
import { save } from './runs.spec-helpers';

const KEY = 'PROJ-470';

const task = (id: string): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

describe('a parent and its subtasks talk both ways', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);
  const child = async (id: string) => (await runs().findRun(`${KEY}-${id}`))!;
  const tasks = async () => parseSubtasks(await documents().latestBody(KEY, 'subtasks'));
  const statuses = async () => Object.fromEntries((await tasks()).map((item) => [item.id, item.status]));
  const pass = async () => {
    await flow.app.pipeline.step('implement', KEY);
    await flow.app.app.get(CommandService).idle();
  };

  async function merged(id: string, iid: number): Promise<void> {
    const run = await child(id);
    await documents().putDocument(run, 'requirements', requirements);
    await documents().putDocument(run, 'repos', 'demo\n');
    const record = { project: 'demo', iid, url: `https://code.example/demo/${iid}`, draft: false, summary: '' };
    await documents().putDocument(run, 'merge_request', renderMergeRequest([record]));
    writeRunState(run, { status: 'done', currentStep: 'done' });
    await runs().saveRun(run);
  }

  it('answers a question, takes a reported decision and gives a handed-back part to a new task, and ends done with no person', async () => {
    const parent = await save(runs(), KEY, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    await runs().saveRun(parent);
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(parent, 'contract', '- api (owner b): the api\n');
    await documents().putDocument(parent, 'subtasks', `${JSON.stringify([task('a'), task('b'), task('c')])}\n`);
    await pass();
    const docs = { ...task('docs'), title: 'Docs', files: ['docs.md'], proof: 'docs.spec.ts' };
    const planner = jest
      .spyOn(SubtaskPlannerAnswer.prototype, 'askAbout')
      .mockImplementation(async (_o, asking) =>
        asking.id === 'a'
          ? { decision: 'Ids are numbers.' }
          : { decision: 'A new task writes the docs.', waitFor: [{ id: 'docs', what: 'the docs' }], addTask: [docs] },
      );

    // b reports a decision: it reaches the contract without anyone being asked.
    const report = [{ key: 'plan-1', decisions: [{ item: 'api', text: 'The api takes ids.' }], outOfScope: [] }];
    await documents().putDocument(await child('b'), 'starter_report', JSON.stringify(report));
    await pass();
    expect(readContract((await documents().latestBody(KEY, 'contract')) ?? '').decisions).toEqual([
      expect.objectContaining({ task: 'b', text: 'api: The api takes ids.' }),
    ]);
    expect(planner).not.toHaveBeenCalled();
    // The decision reaches a running sibling's next prompt and the contract the parent's final review reads.
    const told = await new StarterBriefing(runs(), documents()).prepare(await child('c'), 'implement', null, {
      continued: false,
    });
    expect(told?.told).toContain('b at ');
    expect(told?.told).toContain('api: The api takes ids.');
    const reviewed = await new InputReader(documents()).reread(KEY, ARTIFACTS.contract);
    expect(reviewed).toContain('api: The api takes ids.');

    // a asks a question in research and gets the decision of the planner.
    const a = await child('a');
    await documents().putDocument(a, 'repos', 'demo\n');
    await documents().putDocument(a, 'questions', '- which type?\n');
    writeRunState(a, { status: 'waiting', currentStep: 'research' });
    await runs().saveRun(a);
    await pass();
    expect(await documents().latestBody(`${KEY}-a`, 'answers')).toBe(
      'question: which type?\nanswer: Ids are numbers.\n',
    );

    // c hands back a part no task owns: it becomes a new task, which c waits for.
    const c = await child('c');
    await documents().putDocument(c, 'repos', 'demo\n');
    await flow.app.app
      .get(DocumentRepository)
      .putDocument(
        c,
        'plan_chat',
        `${JSON.stringify({ entries: [{ key: 'handback-implement-1-0', role: 'planner', kind: 'escalation', from: 'implement', text: 'hands back: the docs', at: '2026-01-01T00:00:00.000Z', state: 'pending' }], revisions: [] })}\n`,
      );
    writeRunState(c, { status: 'waiting', currentStep: 'implement' });
    await runs().saveRun(c);
    await pass();
    expect((await tasks()).map((item) => item.id)).toEqual(['a', 'b', 'c', 'docs']);
    expect((await tasks()).find((item) => item.id === 'c')?.depends).toEqual(['docs']);
    expect(readPlanChat(await documents().latestBody(KEY, 'plan_chat')).revisions[0]).toMatchObject({
      added: [expect.stringContaining('Docs')],
    });

    // The tasks merge, the new one first; the epic goes on to its checks and no person was asked.
    for (const [id, iid] of [
      ['docs', 1],
      ['a', 2],
      ['b', 3],
    ] as const)
      await merged(id, iid);
    await pass();
    await pass();
    await merged('c', 4);
    await pass();
    await pass();

    expect(await statuses()).toEqual({ a: 'merged', b: 'merged', c: 'merged', docs: 'merged' });
    expect((await runs().findRun(KEY))?.currentStep).toBe('checks');
    const view = await flow.app.app.get(RunQueriesService).flow(KEY);
    expect(view.items).toEqual([]);
  });
});
