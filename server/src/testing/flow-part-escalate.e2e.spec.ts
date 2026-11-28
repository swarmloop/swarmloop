import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { agentFor } from '../config/agents';
import { AppConfig } from '../config/env';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { RunQueriesService } from '../api/run-queries.service';
import { readPlanChat } from '../contract/plan-chat';
import type { Subtask } from '../contract/subtask';
import { BacklogRepository } from '../history/backlog.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';
import { remoteProject } from '../integrations/code-host/remote-project';
import { BacklogPlanner } from '../pipeline/backlog/planner/backlog-planner';
import { CommandService } from '../pipeline/command.service';
import { FAKE_MODEL_KEY } from './env.spec-helpers';
import { assertInvariants } from './flow-invariants';
import { createFlowHarness } from './flow-harness';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import { git, save } from './runs.spec-helpers';

const KEY = 'PROJ-490';
const OWNER = 'owner';
const BACKLOG = 'shop';
const QUESTION = 'Which type are the ids?';
const WORDS = 'The owner must decide whether the ids are numbers or text.';

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

const part = (id: string): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

/** The backlog planner's turn: its actions are filled in once the question of the epic is known. */
function turnOf(say: string): { block: { say: string; actions: unknown[] } } {
  return { block: { say, actions: [] } };
}

describe('the planner of an epic escalates the question of a part', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  async function boot(epicPlanner: ScriptedAnswer[], backlogPlanner: ScriptedAnswer[] = []): Promise<void> {
    flow = await createFlowHarness(KEY, {
      env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
      blocks: new BlockAgentRunner({ plan: epicPlanner, 'backlog-plan': backlogPlanner }),
    });
    flow.fastWaits();
    const url = `file://${join(flow.app.root, 'demo.git')}`;
    git(join(flow.app.root, 'demo'), ['remote', 'set-url', 'origin', url]);
    remoteProject(url);
    flow.host.defaultBranchPasses();
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.app.app.get(CommandService).idle();
    await flow.app.pipeline.whenIdle(KEY);
    await assertInvariants(flow.app);
    await flow.close();
  });

  const get = <T>(token: new (...args: never[]) => T): T => flow.app.app.get(token);
  const documents = () => get(DocumentRepository);

  /** A backlog whose one task is the epic, as a start of the backlog left it. */
  async function seedBacklog(): Promise<void> {
    flow.backlog();
    const backlogs = get(BacklogRepository);
    const at = new Date(flow.app.clock.now()).toISOString();
    const backlog = await backlogs.saveBacklog({
      name: BACKLOG,
      owner: OWNER,
      repositories: ['demo'],
      mergeMode: 'green',
      paused: false,
      createdAt: at,
    });
    const milestone = await backlogs.saveMilestone({
      backlogId: backlog.id as number,
      number: 1,
      title: 'M1',
      goal: '',
      status: 'active',
      createdAt: at,
    });
    await backlogs.saveTask({
      backlogId: backlog.id as number,
      milestoneId: milestone.id as number,
      slug: 'epic',
      title: 'The epic',
      description: 'Ship the field',
      repositories: ['demo'],
      covers: [],
      depends: [],
      files: [],
      proof: [],
      manual: false,
      fixesMain: null,
      status: 'waiting',
      runKey: KEY,
      note: '',
      runNow: false,
      mergeOk: false,
      merged: {},
      madeBy: 'person',
      position: 1,
      createdAt: at,
    });
  }

  /** The epic of a backlog task, with one part that waits in research with its question. */
  async function epicWithAskingPart(): Promise<string> {
    const epic = await save(get(RunRepository), KEY, 'implement', 'waiting');
    epic.split = true;
    epic.projects = 'demo\n';
    await storeRun(get(RunRepository), epic);
    await documents().putDocument(epic, 'requirements', requirements);
    await documents().putDocument(epic, 'repos', 'demo\n');
    await documents().putDocument(epic, 'contract', '- api (owner a): the api\n');
    await documents().putDocument(epic, 'subtasks', `${JSON.stringify([part('a')])}\n`);
    // The planner of the epic has a chat the visits of its parts' questions resume.
    const { root } = flow.app;
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(agentStateDir(root, KEY, 'plan'), { recursive: true });
    const runtime = agentFor(get(AppConfig).env, epic, 'plan').runtime;
    writeFileSync(join(root, 'data', `${KEY}-plan-session.json`), JSON.stringify({ chatId: 'chat-1', runtime }));
    await seedBacklog();
    await epicPass();
    const child = (await get(RunRepository).findRun(`${KEY}-a`))!;
    await documents().putDocument(child, 'repos', 'demo\n');
    await documents().putDocument(child, 'questions', `- ${QUESTION}\n`);
    writeRunState(child, { status: 'waiting', currentStep: 'research' });
    await storeRun(get(RunRepository), child);
    return child.key;
  }

  async function epicPass(): Promise<void> {
    await flow.app.pipeline.step('implement', KEY);
    await get(CommandService).idle();
  }

  const state = async () => storedState((await get(RunRepository).findRun(KEY))!);
  const items = async () => (await get(RunQueriesService).flow(KEY)).items;
  const chatOf = async () => readPlanChat(await documents().latestBody(KEY, 'plan_chat')).entries;

  it('holds the question with the planner words at the backlog planner, whose answer reaches the part', async () => {
    const backlog = turnOf('I decided for the owner.');
    await boot([{ block: { escalate: WORDS } }], [backlog]);
    const child = await epicWithAskingPart();

    await epicPass();

    expect((await state()).reason?.code).toBe('ASKS_PLANNER');
    const [held] = await items();
    expect(held).toMatchObject({ holder: 'planner' });
    expect(held.id).toContain(`Subtask a asks: - ${QUESTION}`);
    expect(held.id).toContain(WORDS);
    const chat = await chatOf();
    expect(chat.filter((entry) => entry.kind === 'escalation').map((entry) => entry.text)).toEqual([WORDS]);
    expect(chat.filter((entry) => entry.key.startsWith('decision-'))).toEqual([]);
    expect(await documents().latestBody(child, 'answers')).toBeNull();

    backlog.block.actions.push({
      action: 'answerRun',
      run: KEY,
      answers: [{ kind: 'question', id: held.id, body: 'Ids are numbers.' }],
      reason: 'The requirements name numeric ids.',
    });
    await flow.backlog().scheduler.tick();
    await get(BacklogPlanner).whenIdle();
    await flow.app.pipeline.whenIdle(KEY);
    await epicPass();

    expect(await documents().latestBody(child, 'answers')).toContain('answer: Ids are numbers.');
  });

  it('goes on as before with an answer that has a decision and no escalation', async () => {
    await boot([{ block: { decision: 'Ids are numbers.' } }]);
    const child = await epicWithAskingPart();

    await epicPass();

    expect(await documents().latestBody(child, 'answers')).toBe(`question: ${QUESTION}\nanswer: Ids are numbers.\n`);
    expect(await items()).toEqual([]);
    const chat = await chatOf();
    expect(chat.filter((entry) => entry.key.startsWith('decision-')).map((entry) => entry.text)).toEqual([
      'Ids are numbers.',
    ]);
    expect(chat.filter((entry) => entry.kind === 'escalation')).toEqual([]);
  });

  it('does not show the person a question of a part again that the person answered once, and gives the part the answer', async () => {
    await boot([{ block: { escalate: WORDS } }]);
    const child = await epicWithAskingPart();
    const epic = (await get(RunRepository).findRun(KEY))!;
    const at = new Date(flow.app.clock.now()).toISOString();
    const record = [{ asker: 'subtask:a', decide: `- ${QUESTION}`, answer: 'Ids are numbers.', at }];
    await documents().putDocument(epic, 'answered_questions', JSON.stringify(record));

    await epicPass();

    expect(await items()).toEqual([]);
    expect(await documents().latestBody(child, 'answers')).toContain('answer: Ids are numbers.');
    expect(await documents().latestBody(KEY, 'contract')).toContain('Ids are numbers.');
  });
});
