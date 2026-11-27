import 'reflect-metadata';
import { RunQueriesService } from '../../api/run-queries.service';
import { needsPerson } from '../../contract/run-state';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { BacklogQueries } from '../../pipeline/backlog/backlog-queries';
import { BacklogPlanner } from '../../pipeline/backlog/planner/backlog-planner';
import { DEFAULT_RESEARCH } from '../result-answer';
import { remember } from '../runs.spec-helpers';
import {
  BACKLOG,
  bootPlanner,
  LIMIT,
  NO_RESULT,
  PAST_THE_LIMIT,
  says,
  type PlannerBoot,
} from './planner-faults.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const QUESTION = 'Which field is optional?';
const LEFT_LINE = "The planner's turn ended without answering this question, so it goes to you.";

describe('a question of a backlog run while the planner turn that holds it waits or failed', () => {
  let boot: PlannerBoot;

  afterEach(async () => {
    jest.useRealTimers();
    await boot.flow.close();
  });

  const get = <T>(token: new (...args: never[]) => T): T => boot.flow.app.app.get(token);
  const stored = async (runKey: string) => storedState((await get(RunRepository).findRun(runKey))!);
  const items = async (runKey: string) => (await get(RunQueriesService).flow(runKey)).items;
  const statuses = async () => (await boot.chat()).turns.map((turn) => turn.status);

  /** A backlog task whose run asks its question at research and waits for the planner's turn, which the scheduler's pass wakes. */
  async function asking(): Promise<string> {
    boot = await bootPlanner({ research: [{ block: { ...DEFAULT_RESEARCH, questions: [QUESTION] } }] });
    const runKey = await boot.startRun(await boot.backlogWithTask());
    await remember(get(RunRepository), get(DocumentRepository), runKey, 'research', 'waiting');
    await boot.flow.app.pipeline.step('research', runKey);
    await boot.flow.app.pipeline.whenIdle(runKey);
    await boot.flow.tick();
    return runKey;
  }

  /** The planner's pass that the events of the scheduler wake, and the turn it runs. */
  async function plannerPass(): Promise<void> {
    await boot.flow.backlog().scheduler.tick();
    await boot.idle();
  }

  /** The question waits with the planner, and the person is not asked. */
  async function expectHeldByPlanner(runKey: string): Promise<void> {
    expect((await stored(runKey)).reason?.code).toBe('ASKS_PLANNER');
    expect(await items(runKey)).toMatchObject([{ id: QUESTION, holder: 'planner' }]);
    const [task] = (await get(BacklogQueries).view(BACKLOG)).tasks;
    expect(needsPerson(task.run!.state, task.run!.stateReason)).toBe(false);
  }

  describe('while its turn waits for a usage limit', () => {
    it('keeps the question with the planner, and the turn that runs at its next try answers it', async () => {
      const runKey = await asking();
      const answer = says('I answered the run.');
      boot.answers.push(LIMIT, LIMIT, { block: answer.block });
      await plannerPass();

      expect(await statuses()).toEqual(['waiting']);
      await expectHeldByPlanner(runKey);

      answer.block.actions.push({
        action: 'answerRun',
        run: runKey,
        answers: [{ kind: 'question', id: QUESTION, body: 'The phone field.' }],
        reason: 'The requirements make only the phone optional.',
      });
      boot.flow.app.clock.advance(PAST_THE_LIMIT);
      await jest.advanceTimersByTimeAsync(PAST_THE_LIMIT);
      await boot.idle();

      expect(await statuses()).toEqual(['done']);
      expect(await get(DocumentRepository).latestBody(runKey, 'answers')).toContain('answer: The phone field.');
      expect(await get(DocumentRepository).latestBody(runKey, 'passed_on')).toBeNull();
      expect(boot.flow.launched).toContain(runKey);
      await settle(boot.flow.app);
      await assertSettled(boot.flow.app);
    });

    it('keeps the question with the planner, and the turn at its next try passes it on when it leaves it', async () => {
      const runKey = await asking();
      boot.answers.push(LIMIT, LIMIT, says('I looked at it.'));
      await plannerPass();
      await expectHeldByPlanner(runKey);

      boot.flow.app.clock.advance(PAST_THE_LIMIT);
      await jest.advanceTimersByTimeAsync(PAST_THE_LIMIT);
      await boot.idle();

      expect(await statuses()).toEqual(['done']);
      expect((await stored(runKey)).reason?.code).toBe('NEEDS_ANSWERS');
      expect(await items(runKey)).toMatchObject([{ id: QUESTION, passedOn: LEFT_LINE }]);
      await settle(boot.flow.app);
      await assertSettled(boot.flow.app);
    });
  });

  describe('while its turn failed', () => {
    it('keeps the question with the planner, and Resume runs the turn that answers it', async () => {
      const runKey = await asking();
      boot.answers.push(NO_RESULT, NO_RESULT, NO_RESULT);
      await plannerPass();

      expect(await statuses()).toEqual(['failed']);
      await expectHeldByPlanner(runKey);

      boot.answers.length = 0;
      const answer = says('I answered the run.');
      answer.block.actions.push({
        action: 'answerRun',
        run: runKey,
        answers: [{ kind: 'question', id: QUESTION, body: 'The email field.' }],
        reason: 'The requirements make only the email optional.',
      });
      boot.answers.push({ block: answer.block });
      await get(BacklogPlanner).resume(BACKLOG);
      await boot.idle();

      expect(await statuses()).toEqual(['done']);
      expect(await get(DocumentRepository).latestBody(runKey, 'answers')).toContain('answer: The email field.');
      await settle(boot.flow.app);
      await assertSettled(boot.flow.app);
    });

    it('keeps the question with the planner, and the next turn that a message starts passes it on when it leaves it', async () => {
      const runKey = await asking();
      boot.answers.push(NO_RESULT, NO_RESULT, NO_RESULT);
      await plannerPass();
      await expectHeldByPlanner(runKey);

      boot.answers.length = 0;
      boot.answers.push(says('I looked at it.'));
      await boot.say('Any news?');
      await boot.idle();

      expect(await statuses()).toEqual(['failed', 'done']);
      expect((await stored(runKey)).reason?.code).toBe('NEEDS_ANSWERS');
      expect(await items(runKey)).toMatchObject([{ id: QUESTION, passedOn: LEFT_LINE }]);
      const [task] = (await get(BacklogQueries).view(BACKLOG)).tasks;
      expect(needsPerson(task.run!.state, task.run!.stateReason)).toBe(true);
      await settle(boot.flow.app);
      await assertSettled(boot.flow.app);
    });
  });
});
