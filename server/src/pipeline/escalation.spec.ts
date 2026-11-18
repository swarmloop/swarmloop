import type { PlanChatEntry } from '../contract/plan-chat';
import { DocumentRepository } from '../history/document.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { closeEscalation, escalateToPerson, escalationLine } from './escalation';

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
});
