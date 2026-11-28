import type { PlanChatEntry } from '../contract/plan-chat';
import { DocumentRepository } from '../history/document.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { closeEscalation, escalateToPerson, escalationLine, isAsked } from './escalation';

describe('an escalated question for the person', () => {
  const escalation: PlanChatEntry = {
    key: 'escalate-ask-1',
    role: 'planner',
    kind: 'escalation',
    from: 'code-review-quality',
    text: 'Which pagination do you want?\nCursor or page?',
    at: '2026-01-01T00:00:00.000Z',
    state: 'pending',
  };

  it('is one line with the step in words and the time it was asked', () => {
    expect(escalationLine(escalation)).toBe(
      'code review quality asks: Which pagination do you want? Cursor or page? (asked 2026-01-01T00:00:00.000Z)',
    );
  });

  it('is written once with its parts next to the open lines, and closes only when taken out', async () => {
    const db = await repositoryDatabase();
    try {
      const run = await db.app.get(RunRepository).openWaiting('PROJ-1', '/target');
      const documents = db.app.get(DocumentRepository);
      await documents.putDocument(run, 'questions', '- Another open line\n');
      const line = escalationLine(escalation);

      await escalateToPerson(documents, run, escalation);
      await escalateToPerson(documents, run, escalation);

      expect(await documents.latestBody('PROJ-1', 'questions')).toBe(`- Another open line\n- ${line}\n`);
      const stored = JSON.parse((await documents.latestBody('PROJ-1', 'question_parts')) ?? '[]');
      expect(stored).toEqual([
        {
          question: line,
          parts: {
            decide: escalation.text,
            sides: [{ who: 'planner', text: 'The planner gave no answer.' }],
            full: '',
            askedAt: escalation.at,
            asker: 'code-review-quality',
            entry: 'escalate-ask-1',
          },
        },
      ]);

      await closeEscalation(documents, run, escalation);

      expect(await documents.latestBody('PROJ-1', 'questions')).toBe('- Another open line\n');
      expect(JSON.parse((await documents.latestBody('PROJ-1', 'question_parts')) ?? '[]')).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('does not put a question again that the person answered before, and returns the stored answer', async () => {
    const db = await repositoryDatabase();
    try {
      const run = await db.app.get(RunRepository).openWaiting('PROJ-1', '/target');
      const documents = db.app.get(DocumentRepository);
      const record = [
        { asker: 'code-review-quality', decide: escalation.text.trim(), answer: 'Cursor', at: escalation.at },
      ];
      await documents.putDocument(run, 'answered_questions', JSON.stringify(record));

      expect(await escalateToPerson(documents, run, escalation)).toEqual({ kind: 'answered', answer: 'Cursor' });

      expect(await documents.latestBody('PROJ-1', 'questions')).toBeNull();
      expect(await isAsked(documents, run, escalation)).toBe(false);
    } finally {
      await db.close();
    }
  });
  it('says whether the question is among the open ones', async () => {
    const db = await repositoryDatabase();
    try {
      const run = await db.app.get(RunRepository).openWaiting('PROJ-1', '/target');
      const documents = db.app.get(DocumentRepository);
      expect(await isAsked(documents, run, escalation)).toBe(false);
      await escalateToPerson(documents, run, escalation);
      expect(await isAsked(documents, run, escalation)).toBe(true);
      await closeEscalation(documents, run, escalation);
      expect(await isAsked(documents, run, escalation)).toBe(false);
    } finally {
      await db.close();
    }
  });
});
