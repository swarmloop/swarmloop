import { ConflictException } from '@nestjs/common';
import type { BacklogTurnAction } from '../../../agent-result/definitions/backlog-turn';
import { DocumentRepository } from '../../../history/document.repository';
import { storedState } from '../../../history/run-state';
import { ARTIFACTS } from '../../../steps/contract/artifacts';
import { turnResult, withPlanner } from './planner-scenarios.spec-helpers';

type Harness = Parameters<Parameters<typeof withPlanner>[0]>[0];

const QUESTION = 'Which store?';

/** A task whose run waits at research on a question the planner holds, and the turn that took that question's event. */
async function asking(h: Harness) {
  const { backlogId } = await h.seed();
  await h.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });
  await h.run('going-1', { status: 'waiting', currentStep: 'research', facts: { asksPlanner: true } });
  const run = (await h.runs.findRun('going-1')) as NonNullable<Awaited<ReturnType<typeof h.runs.findRun>>>;
  const documents = h.app.get(DocumentRepository);
  await documents.putDocument(run, 'questions', `- ${QUESTION}\n`);
  const facts = { slug: 'going', runKey: 'going-1', questionId: QUESTION, question: QUESTION };
  await h.addEvent(backlogId, 'asks-planner:going-1:1:abc', 'run-asks-planner', facts);
  await h.chat.takeInto(backlogId, 'turn-1');
  const passed = async () =>
    ARTIFACTS.passedOn.parse((await documents.latestBody('going-1', ARTIFACTS.passedOn.kind)) ?? '[]');
  const reason = async () => storedState((await h.runs.findRun('going-1')) as never).reason?.code;
  return { backlogId, run, documents, passed, reason };
}

describe('LeftQuestions', () => {
  it('passes on a question its turn neither answered nor passed on, with the line and a chat line, once', () =>
    withPlanner(async (h) => {
      const { backlogId, passed, reason } = await asking(h);
      expect(await reason()).toBe('ASKS_PLANNER');

      await h.turns.apply('alpha', 'turn-1', turnResult('Looked at it.'));
      await h.turns.apply('alpha', 'turn-1', turnResult('Looked at it.'));

      expect(await reason()).toBe('NEEDS_ANSWERS');
      expect(await passed()).toEqual([
        {
          question: QUESTION,
          line: "The planner's turn ended without answering this question, so it goes to you.",
          at: h.clock.iso(),
        },
      ]);
      expect(await h.lines(backlogId)).toEqual([
        'Looked at it.',
        'My turn ended without answering the question of going-1, so it now goes to you.',
      ]);
    }));

  const handled: [string, BacklogTurnAction][] = [
    ['an answer', { action: 'answerRun', run: 'going-1', answers: [{ body: 'in memory' }] }],
    ['a message to the run planner', { action: 'planChat', run: 'going-1', message: 'use memory' }],
    ['a pass-on of its own', { action: 'passQuestion', run: 'going-1', reason: 'Yours.' }],
  ];

  it.each(handled)('passes nothing on for a question its turn handled with %s', (_name, action) =>
    withPlanner(async (h) => {
      const { backlogId, passed } = await asking(h);

      await h.turns.apply('alpha', 'turn-1', turnResult('', action));

      expect(await passed()).toEqual([]);
      expect((await h.lines(backlogId)).join('\n')).not.toContain('ended without answering');
    }),
  );

  it('passes on the question beside the one its turn answered or passed on by id', () =>
    withPlanner(async (h) => {
      const { backlogId, run, documents, passed } = await asking(h);
      await documents.putDocument(run, 'questions', `- ${QUESTION}\n- Which queue?\n`);
      await h.addEvent(backlogId, 'asks-planner:going-1:1:def', 'run-asks-planner', {
        slug: 'going',
        runKey: 'going-1',
        questionId: 'Which queue?',
        question: 'Which queue?',
      });
      await h.chat.takeInto(backlogId, 'turn-1');

      await h.turns.apply(
        'alpha',
        'turn-1',
        turnResult('', { action: 'passQuestion', run: 'going-1', question: QUESTION, reason: 'Yours.' }),
      );

      expect((await passed()).map((entry) => entry.question)).toEqual(['Which queue?']);
    }));

  it('skips a question the person answered meanwhile, with no refusal', () =>
    withPlanner(async (h) => {
      const { backlogId, run, documents, passed } = await asking(h);
      await documents.putDocument(run, 'answers', `question: ${QUESTION}\nanswer: in memory\n`);

      await h.turns.apply('alpha', 'turn-1', turnResult(''));

      expect(await passed()).toEqual([]);
      expect(await h.lines(backlogId)).toEqual([]);
      expect((await h.backlogs.events(backlogId, 100)).map((event) => event.kind)).not.toContain('command-refused');
    }));
  const answer = turnResult('', { action: 'answerRun', run: 'going-1', answers: [{ body: 'in memory' }] });
  const LEFT_CHAT = 'My turn ended without answering the question of going-1, so it now goes to you.';

  it('carries a question whose answer the run refused to the next turn, which passes it on as it ends', () =>
    withPlanner(async (h) => {
      const { backlogId, passed, reason } = await asking(h);
      h.failNext(new ConflictException('going-1 is not running'));
      await h.turns.apply('alpha', 'turn-1', answer);

      expect(await reason()).toBe('ASKS_PLANNER');
      expect(await passed()).toEqual([]);
      const refused = (await h.backlogs.events(backlogId, 100)).filter((event) => event.kind === 'command-refused');
      expect(refused.map((event) => event.facts)).toMatchObject([
        { run: 'going-1', reason: 'going-1 is not running', questions: QUESTION },
      ]);

      const taken = await h.chat.takeInto(backlogId, 'turn-2');
      expect(taken.events.map((event) => event.kind)).toEqual(['command-refused']);
      await h.turns.apply('alpha', 'turn-2', turnResult(''));

      expect(await reason()).toBe('NEEDS_ANSWERS');
      expect((await passed()).map((entry) => entry.question)).toEqual([QUESTION]);
      expect((await h.lines(backlogId)).filter((line) => line === LEFT_CHAT)).toHaveLength(1);
    }));

  it('passes the question on at once when the next answer is refused for the same reason', () =>
    withPlanner(async (h) => {
      const { backlogId, passed, reason } = await asking(h);
      h.failNext(new ConflictException('going-1 is not running'));
      await h.turns.apply('alpha', 'turn-1', answer);
      await h.chat.takeInto(backlogId, 'turn-2');
      h.failNext(new ConflictException('going-1 is not running'));
      await h.turns.apply('alpha', 'turn-2', answer);

      expect(await reason()).toBe('NEEDS_ANSWERS');
      expect((await passed()).map((entry) => entry.question)).toEqual([QUESTION]);
      expect((await h.lines(backlogId)).filter((line) => line === LEFT_CHAT)).toHaveLength(1);
      const refused = (await h.backlogs.events(backlogId, 100)).filter((event) => event.kind === 'command-refused');
      expect(refused).toHaveLength(1);
    }));
});
