import type { PlanChatEntry } from '../contract/plan-chat';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { latest } from '../history/latest-document';
import { answered } from '../steps/shared/answers';
import { OPEN_ITEM_KINDS, openItems } from '../steps/shared/open-items';
import { escalateToPerson, escalationLine } from './escalation';
import { closeSkippedQuestions } from './skipped-questions';

const REASON = 'this task was skipped';

const entry = (key: string, kind: 'question' | 'escalation'): PlanChatEntry => ({
  key,
  role: 'planner',
  kind,
  from: 'research',
  text: `text of ${key}`,
  at: '2026-01-01T00:00:00.000Z',
  state: 'pending',
});

async function world() {
  const db = await repositoryDatabase();
  const runs = db.app.get(RunRepository);
  const documents = db.app.get(DocumentRepository);
  const chat = db.app.get(PlanChatStore);
  await runs.openWaiting('run-1', '/target');
  const run = await runs.change('run-1', (row) => {
    row.currentStep = 'research';
  });
  const items = async () =>
    openItems(run, await documents.latestDocuments([run.id], [...OPEN_ITEM_KINDS]), []).map(
      (item) => `${item.id} => ${item.answer}`,
    );
  return { db, run, documents, chat, items, close: () => closeSkippedQuestions({ documents, chat }, run, REASON) };
}

describe('closeSkippedQuestions', () => {
  it('answers each open question with the reason and keeps the answers already given', async () => {
    const { db, run, documents, items, close } = await world();
    try {
      await documents.putDocument(run, 'questions', '- first?\n- second?\n');
      await documents.putDocument(run, 'answers', 'question: first?\nanswer: yes\n');

      await close();

      expect(await items()).toEqual(['first? => yes', `second? => ${REASON}`]);
    } finally {
      await db.close();
    }
  });

  it('takes a raised escalation and a pending one that was not raised, with the reason', async () => {
    const { db, run, documents, chat, items, close } = await world();
    try {
      const raised = entry('escalate-a', 'escalation');
      await chat.appendEntry(run.key, raised);
      await chat.appendEntry(run.key, entry('escalate-b', 'escalation'));
      await chat.appendEntry(run.key, entry('ask-1', 'question'));
      await escalateToPerson(documents, run, raised);

      await close();

      expect(await items()).toEqual([`${escalationLine(raised)} => ${REASON}`]);
      expect(await chat.pendingEscalations(run.key)).toEqual([]);
      expect(await chat.pendingQuestions(run.key)).toEqual([]);
      const { entries } = await chat.read(run.key);
      expect(entries.map((one) => [one.key, one.state, one.closed])).toEqual([
        ['escalate-a', 'taken', REASON],
        ['escalate-b', 'taken', REASON],
        ['ask-1', 'taken', REASON],
      ]);
    } finally {
      await db.close();
    }
  });

  it('writes nothing a second time', async () => {
    const { db, run, documents, close } = await world();
    try {
      await documents.putDocument(run, 'questions', '- first?\n');
      await close();
      const once = await documents.latestDocuments([run.id], ['answers']);

      await close();

      expect(await documents.latestDocuments([run.id], ['answers'])).toHaveLength(once.length);
      expect(answered(latest(once, 'answers') ?? '').get('first?')).toBe(REASON);
    } finally {
      await db.close();
    }
  });
});
