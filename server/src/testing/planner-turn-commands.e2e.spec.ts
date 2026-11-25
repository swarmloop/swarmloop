import 'reflect-metadata';
import { PlanChatStore } from '../history/plan-chat.store';
import { parseSubtasks } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { CommandService } from '../pipeline/command.service';
import { PlannerRunPort } from '../pipeline/backlog/planner/planner-run-port';
import { PipelineService } from '../pipeline/pipeline.service';
import { PlannerTurns } from '../pipeline/planner-turns';
import { createFlowHarness } from './flow-harness';
import { gapEpic, missing } from './gap-epic.spec-helpers';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import { writeChat } from '../steps/plan/plan.step.spec-helpers';

const KEY = 'PROJ-481';
const OWNER = 'ana';

const block = (value: unknown): ScriptedAnswer => ({ block: value });
const SPLIT = (id: string) => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  covers: ['R3'],
});
const contract = [{ id: 'item-1', text: 'd is added', owner: 'a' }];
const SPLIT_R = (id: string, covers: string) => ({ ...SPLIT(id), covers: [covers] });
/** The epic's tasks as they stand when its gap question waits: plan-improve must give the started ones back unchanged. */
const STANDING = [
  SPLIT_R('a', 'R1'),
  SPLIT_R('b', 'R2'),
  SPLIT_R('c', 'R3'),
  {
    id: 'gap-1',
    title: 'Close the gap in R3',
    description: [
      'The final requirements review marked these as not delivered:',
      '- R3 is missing: nothing writes it',
      'Gap for: R3',
    ].join('\n'),
    depends: ['c'],
    files: ['src/c.ts'],
    proof: 'The requirements review marks R3 met',
    covers: ['R3'],
  },
];
const standing = [
  { id: 'item-1', text: 'the api', owner: 'a' },
  { id: 'item-2', text: 'gap-1 depends on c: both change src/c.ts', owner: 'gap-1' },
  {
    id: 'item-4',
    text: 'subtask gap-1 at 2026-01-01T00:00:00.000Z: The final requirements review marked R3 partial or missing: task gap-1 delivers them.',
    owner: 'gap-1',
  },
  ...contract.map((item) => ({ ...item, id: 'item-3' })),
];
const improved = block({
  summary: ['checked'],
  contract: standing,
  tasks: [...STANDING, SPLIT_R('d', 'R3')],
  keep: [],
});
const adds = block({ reply: 'Added d.', summary: ['d'], contract, tasks: [SPLIT_R('d', 'R3')], keep: [] });

describe('a backlog planner turn sends its commands to a run that waits on a question', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  beforeEach(async () => {
    blocks = new BlockAgentRunner({ plan: [adds], 'plan-improve': [improved] });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all' });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);
  const store = () => flow.app.app.get(PlanChatStore);
  const send = (command: Parameters<PlannerRunPort['send']>[0], key: string) =>
    flow.app.app.get(PlannerRunPort).send(command, OWNER, key);
  const tasks = async () => parseSubtasks(await documents().latestBody(KEY, 'subtasks'));
  const { pass, merged, epic, review } = gapEpic(() => flow, KEY);

  /** An epic that waits on the question of its own gap task that was merged and still left R3 missing. */
  async function waitingEpic(): Promise<string> {
    const parent = await epic();
    parent.epicAt = flow.app.clock.iso();
    await runs().saveRun(parent);
    await review(parent, missing('nothing writes it'));
    await pass();
    await merged('gap-1', 4);
    await pass();
    await pass();
    await review(parent, missing('still not written'));
    await pass();
    const asked = (await documents().latestBody(KEY, 'subtask_questions')) ?? '';
    expect(asked).toContain('R3 is still missing after gap task gap-1 merged');
    writeChat(flow.app.root, KEY, 'claude');
    // The passes above ran the step by hand: the epic waits where its own question was asked.
    const waiting = (await runs().findRun(KEY))!;
    writeRunState(waiting, { status: 'waiting', currentStep: 'implement' });
    await runs().saveRun(waiting);
    return asked;
  }

  it('lands the answer and then takes the message as tasks to add, and the added task starts', async () => {
    await waitingEpic();
    flow.app.clock.advance(1000);

    // The answer starts the run at once; that one start is held until the message is sent, as a turn sends both before the run's first hop.
    const pipeline = flow.app.app.get(PipelineService);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started: Promise<unknown> = Promise.resolve();
    jest.spyOn(pipeline, 'startDetached').mockImplementationOnce(() => {
      started = held.then(() => flow.app.pipeline.runThrough(KEY, { auto: true }));
      return Promise.resolve({ exitCode: 0, message: 'started' });
    });

    await send({ type: 'answer', run: KEY, answers: [{ body: 'Out of scope.' }] }, 'turn-0');
    await send({ type: 'planChat', run: KEY, message: 'Also add d' }, 'turn-1');
    release();
    await started;
    await flow.app.app.get(PlannerTurns).idle();
    await flow.app.app.get(CommandService).idle();
    await flow.app.pipeline.whenIdle(KEY);

    expect(await documents().latestBody(KEY, 'answers')).toContain('answer: Out of scope.');
    expect(blocks.prompts.filter((launch) => launch.step === 'plan').at(-1)?.prompt).toContain('Also add d');
    expect(await store().pending(KEY)).toEqual([]);
    expect((await tasks()).map((item) => item.id)).toEqual(['a', 'b', 'c', 'gap-1', 'd']);
    expect(await runs().findRun(`${KEY}-d`)).not.toBeNull();
  });

  it('stores a message alone as a pending message for the planner, and the answers do not hold it', async () => {
    await waitingEpic();
    flow.app.clock.advance(1000);

    await send({ type: 'planChat', run: KEY, message: 'Also add d' }, 'turn-2');

    expect((await store().read(KEY)).entries).toEqual([
      expect.objectContaining({ text: 'Also add d', state: 'pending' }),
    ]);
    expect(await documents().latestBody(KEY, 'answers')).toBeFalsy();
  });
});
