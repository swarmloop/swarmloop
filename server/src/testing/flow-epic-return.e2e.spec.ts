import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { mkdirSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subtask } from '../contract/subtask';
import { sessionFileName, sessionHome } from '../history/session-group';
import { RunQueriesService } from '../api/run-queries.service';
import { BacklogRepository } from '../history/backlog.repository';
import { storedState } from '../history/run-state';
import { remoteProject } from '../integrations/code-host/remote-project';
import { FAKE_MODEL_KEY } from './env.spec-helpers';
import { DataSource } from 'typeorm';
import { StepStatEntity } from '../history/step-stat.entity';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import { git, remember } from './runs.spec-helpers';

const KEY = 'PROJ-880';
const block = (value: unknown): ScriptedAnswer => ({ block: value });
const returns = (review: string) => block({ decision: 'return', review, summary: ['one finding'] });
const passes = block({ decision: 'ok', review: 'The rows stay.', summary: ['ok'], reason: 'The answer holds.' });
const asks = (review: string, question: string) =>
  block({ decision: 'return', review, summary: ['one finding'], question, reason: 'It still holds.' });
const answers = (finding: 'holds' | 'ruled-out', reply: string) => block({ reply, finding });
const REQUIREMENTS = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;
const FINDING = 'The parser drops a row.';
const account = block({
  implementation: ['No file changed: the reader keeps every row'],
  summary: ['The reader keeps every row, so the finding does not apply.'],
  rejected: [{ reviewer: 'quality', finding: FINDING, reason: 'The reader keeps every row.' }],
});

const merged = (id: string): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  covers: ['R1'],
  status: 'merged',
});

describe('a return to a split parent whose tasks are merged', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  async function start(
    scripts: Record<string, ScriptedAnswer[]>,
    implementCommits = true,
    env: Record<string, string> = {},
  ): Promise<void> {
    blocks = new BlockAgentRunner(scripts);
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', realReview: true, implementCommits, env });
    const documents = flow.app.app.get(DocumentRepository);
    const run = await remember(flow.app.app.get(RunRepository), documents, KEY, 'code-review', 'waiting');
    run.split = true;
    run.projects = 'demo\n';
    await storeRun(flow.app.app.get(RunRepository), run);
    await documents.putDocument(run, 'requirements', REQUIREMENTS);
    await documents.putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
    await documents.putDocument(run, 'implementation', '- the tasks merged\n');
    await documents.putDocument(run, 'subtasks', `${JSON.stringify([merged('a'), merged('b')])}\n`);
    mkdirSync(join(flow.app.root, 'worktrees', KEY, 'demo'), { recursive: true });
    plannerChat();
  }

  /** The epic's planner chat, as its plan visit left it: the planner is asked in that chat. */
  function plannerChat(): void {
    const data = join(flow.app.root, 'data');
    mkdirSync(join(data, 'agent-state', KEY, sessionHome('plan')), { recursive: true });
    const session = { runtime: 'claude', chatId: 'chat-plan', resumed: true, completed: true, killReason: null };
    writeFileSync(join(data, sessionFileName(KEY, 'plan')), JSON.stringify(session));
  }

  afterEach(async () => {
    await flow.close();
  });

  const launches = (step: string) => blocks.prompts.filter((launch) => launch.step === step);
  const epicFiles = () => readdirSync(join(flow.app.root, 'worktrees', KEY, 'demo'));

  it('launches the implement agent on the epic worktree, and the new head is reviewed', async () => {
    await start({ 'code-review-quality': [returns(FINDING), passes] });

    await flow.app.pipeline.runThrough(KEY, { auto: true });
    expect(launches('implement')).toHaveLength(1);
    expect(launches('implement')[0].prompt).toContain(FINDING);
    expect(epicFiles()).toContain('fix-1.txt');
    const visits = (
      await flow.app.app
        .get(DataSource)
        .getRepository(StepStatEntity)
        .find({ order: { id: 'ASC' } })
    ).map((stat) => stat.step);
    expect(visits.filter((step) => ['code-review', 'implement', 'checks'].includes(step))).toEqual([
      'code-review',
      'implement',
      'checks',
      'code-review',
    ]);
    const order = blocks.steps.filter((step) => step === 'implement' || step === 'code-review-quality');
    expect(order).toEqual(['code-review-quality', 'implement', 'code-review-quality']);
    await assertInvariants(flow.app);
  });

  it('asks the planner of the epic when the same finding comes back on the next head, and goes on when it rules the finding out', async () => {
    await start({
      'code-review-quality': [returns(FINDING), asks(FINDING, 'Should rows be kept in order?')],
      plan: [answers('ruled-out', 'The brief keeps rows as they are.')],
    });

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    const entries = (await flow.app.app.get(PlanChatStore).read(KEY)).entries;
    expect(entries.filter((entry) => entry.kind === 'question')).toMatchObject([
      { about: 'finding', from: 'code-review-quality' },
    ]);
    expect(launches('plan').at(-1)?.prompt).toContain(FINDING);
    expect(entries.filter((entry) => entry.kind === 'answer')).toMatchObject([
      { finding: 'ruled-out', state: 'taken' },
    ]);
    expect(launches('plan')).toHaveLength(1);
    expect(launches('implement')).toHaveLength(1);
    expect(launches('code-review-quality')).toHaveLength(2);
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.currentStep).not.toBe('implement');
    await assertInvariants(flow.app);
  });

  it('reviews once more after implement’s answer with no file change, and the refusal of the same tree and account goes up the chain to the person', async () => {
    await start(
      {
        'code-review-quality': [returns(FINDING), asks(FINDING, 'Should rows be kept in order?')],
        implement: [account, account],
        'implement-improve': [account, account],
        plan: [answers('holds', 'The finding holds.'), block({ reply: 'The return stands.' })],
      },
      false,
    );

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(launches('implement')).toHaveLength(2);
    expect(launches('code-review-quality')).toHaveLength(2);
    const entries = (await flow.app.app.get(PlanChatStore).read(KEY)).entries;
    expect(entries.filter((entry) => entry.kind === 'question').map((entry) => entry.text)).toEqual([
      expect.stringContaining('Should rows be kept in order?'),
      expect.stringContaining('Not started again: same input as visit 3'),
    ]);
    expect(launches('plan')).toHaveLength(2);
    expect(entries.map((entry) => entry.kind)).toContain('answer');
    const run = await flow.app.app.get(RunRepository).findRun(KEY);
    expect([run?.currentStep, run?.status]).toEqual(['code-review', 'waiting']);
    await assertInvariants(flow.app);
  });

  it('reaches the backlog planner when the epic planner escalates the finding of a backlog run, and the person is not asked', async () => {
    await start(
      {
        'code-review-quality': [returns(FINDING), asks(FINDING, 'Should rows be kept in order?')],
        plan: [block({ reply: 'A product decision.', finding: 'holds', escalate: 'Which order do rows keep?' })],
      },
      true,
      { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
    );
    await linkToBacklog();

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    const run = await flow.app.app.get(RunRepository).findRun(KEY);
    expect([run?.currentStep, storedState(run!).reason?.code]).toEqual(['code-review', 'ASKS_PLANNER']);
    const items = (await flow.app.app.get(RunQueriesService).flow(KEY)).items;
    expect(items).toMatchObject([{ kind: 'question', holder: 'planner' }]);
    expect(launches('implement')).toHaveLength(1);
    expect(launches('code-review-quality')).toHaveLength(2);
    await assertInvariants(flow.app);
  });

  /** The run is the run of a task of a backlog, so a question the epic's planner passes up reaches the backlog's planner. */
  async function linkToBacklog(): Promise<void> {
    const { actions } = flow.backlog();
    const url = `file://${join(flow.app.root, 'demo.git')}`;
    git(join(flow.app.root, 'demo'), ['remote', 'set-url', 'origin', url]);
    remoteProject(url);
    flow.host.defaultBranchPasses();
    await actions.createBacklog('owner', { name: 'shop', repositories: ['demo'], mergeMode: 'green' });
    await actions.proposeMilestone('owner', 'shop', { title: 'Ship the shop', goal: 'Customers can order.' });
    await actions.addRequirements('owner', 'shop', 1, { texts: ['Orders can be placed'] });
    await actions.addTasks('owner', 'shop', [
      {
        id: 'a',
        title: 'Task a',
        description: 'Do a.',
        repositories: ['demo'],
        files: ['src/a.ts'],
        proof: ['a.spec.ts'],
        milestone: 1,
        covers: ['M1.R1'],
        depends: [],
      },
    ]);
    const backlogs = flow.app.app.get(BacklogRepository);
    const [added] = await backlogs.tasks((await backlogs.findBacklog('shop'))!.id as number);
    await backlogs.saveTask({ ...added, runKey: KEY, status: 'running' });
  }
});
