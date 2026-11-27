import 'reflect-metadata';
import { parseSubtasks } from '../../contract/subtask';
import { NEEDS_ANSWERS, REASON, SKIPPED_NOTE } from '../../contract/run-state';
import { DocumentRepository } from '../../history/document.repository';
import { PlanChatStore } from '../../history/plan-chat.store';
import { RunRepository } from '../../history/run.repository';
import { writeRunState } from '../../history/run-state';
import { CommandService } from '../../pipeline/command.service';
import { PERSON_RESUME } from '../../pipeline/resume-sender';
import { PlannerRunPort } from '../../pipeline/backlog/planner/planner-run-port';
import { ARTIFACTS } from '../../steps/contract/artifacts';
import { renderQuestions } from '../../steps/research/research-record';
import { answered } from '../../steps/shared/answers';
import { skippedByEpic } from '../../steps/shared/subtask-skip-reason';
import { askedQuestion } from '../../steps/implement/split-questions';
import { createFlowHarness } from '../flow-harness';
import { BlockAgentRunner } from '../result-answer';
import { storeRun } from '../store-run.spec-helpers';
import { epicMerges } from './epic-merge.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-917';
const PART = `${KEY}-b`;
const ASKED_AT = '2026-01-01T00:00:00.000Z';
const ASKED = askedQuestion('b', 'Which one?', ASKED_AT);
const ASKS = { code: NEEDS_ANSWERS, message: 'questions are open' };
const DELIVERED = 'already delivered: src/b.ts';

describe('an epic whose started part is skipped while its question is open', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, {
      realHost: true,
      taskWorktrees: true,
      blocks: new BlockAgentRunner({}),
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);
  const chat = () => flow.app.app.get(PlanChatStore);
  const commands = () => flow.app.app.get(CommandService);
  const epic = epicMerges(() => flow, KEY);
  const statuses = async () =>
    Object.fromEntries(
      parseSubtasks(await documents().latestBody(KEY, 'subtasks')).map((item) => [item.id, item.status]),
    );
  const answers = async () => answered((await documents().latestBody(KEY, 'answers')) ?? '');
  const planner = (type: 'skipTask') =>
    flow.app.app.get(PlannerRunPort).send({ type, run: KEY, task: 'b' }, 'ana', 'turn-skip');

  /** Part a merged; part b is started and waits at implement on an escalation, which its epic carries as an open question. The epic waits on it. */
  async function seedAsking(): Promise<void> {
    await epic.seed(['a', 'b']);
    await epic.deliver('a');
    await flow.app.pipeline.step('implement', KEY);
    const part = (await runs().findRun(PART))!;
    writeRunState(part, { status: 'waiting', currentStep: 'implement' });
    await storeRun(runs(), part);
    await chat().appendEntry(PART, {
      key: 'escalate-1',
      role: 'planner',
      kind: 'escalation',
      from: 'implement',
      text: 'Which one?',
      at: ASKED_AT,
      state: 'pending',
    });
    const parent = (await runs().findRun(KEY))!;
    await documents().putDocument(parent, 'subtask_questions', renderQuestions([ASKED.question]));
    await documents().putDocument(parent, 'question_parts', ARTIFACTS.questionParts.format([ASKED]));
    writeRunState(parent, {
      status: 'waiting',
      currentStep: 'implement',
      reason: ASKS,
    });
    await storeRun(runs(), parent);
  }

  /** The epic went on with its settled parts, and nobody is asked the question of the skipped one: it reads closed with the skip as reason. */
  async function expectWentOn(reason: string): Promise<void> {
    expect(await statuses()).toEqual({ a: 'merged', b: 'skipped' });
    expect((await runs().findRun(KEY))!.currentStep).not.toBe('implement');
    expect((await answers()).get(ASKED.question)).toBe(reason);
    expect(await documents().latestBody(KEY, 'subtask_questions')).toBe('');
    expect((await chat().read(PART)).entries.map((entry) => [entry.state, entry.closed])).toEqual([['taken', reason]]);
    expect(await chat().pending(PART)).toEqual([]);
    await expect(commands().submit('resume', PART, {})).rejects.toThrow(SKIPPED_NOTE);
    await assertSettled(flow.app);
  }

  it("goes on after a person's Skip of the part", async () => {
    await seedAsking();

    await commands().submit('skip', KEY, { taskId: 'b' });
    await settle(flow.app);

    await expectWentOn(SKIPPED_NOTE);
  });

  it("goes on after the backlog planner's skip of the part", async () => {
    await seedAsking();

    await planner('skipTask');
    await settle(flow.app);

    await expectWentOn(SKIPPED_NOTE);
  });

  it("goes on when the epic's own pass skips the part", async () => {
    await seedAsking();
    const part = (await runs().findRun(PART))!;
    await documents().putDocument(part, 'commit', `${DELIVERED}\n`);
    writeRunState(part, { status: 'done', currentStep: 'done' });
    await storeRun(runs(), part);

    await flow.app.pipeline.step('implement', KEY);
    expect((await runs().findRun(KEY))!.currentStep).toBe('checks');
    await commands().submit('resume', KEY, { ...PERSON_RESUME });
    await settle(flow.app);

    await expectWentOn(skippedByEpic(DELIVERED));
  });

  it('goes on by a Resume when the part was stored skipped, its question open and the epic failed at implement', async () => {
    await seedAsking();
    const part = (await runs().findRun(PART))!;
    writeRunState(part, { status: 'blocked', reason: { code: REASON.skipped, message: SKIPPED_NOTE } });
    await storeRun(runs(), part);
    const parent = (await runs().findRun(KEY))!;
    await documents().putDocument(
      parent,
      'subtasks',
      ARTIFACTS.subtasks.format(
        parseSubtasks(await documents().latestBody(KEY, 'subtasks')).map((item) =>
          item.id === 'b' ? { ...item, status: 'skipped' } : item,
        ),
      ),
    );
    writeRunState(parent, {
      status: 'failed',
      currentStep: 'implement',
      reason: { code: 'STEP_FAILED', message: `implement failed: ${SKIPPED_NOTE}` },
    });
    await storeRun(runs(), parent);

    await commands().submit('resume', KEY, { ...PERSON_RESUME });
    await settle(flow.app);

    await expectWentOn(SKIPPED_NOTE);
  });
});
