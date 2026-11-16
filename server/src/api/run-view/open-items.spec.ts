import type { DocumentEntity, RunEntity } from '../../history/entities';
import { renderQuestions } from '../../steps/research/research-record';
import { resumeState, stateView } from './flow';
import { openItems } from './open-items';

describe('open questions of the run view', () => {
  const run = { currentStep: 'research' } as RunEntity;
  const doc = (kind: string, body: string) => ({ kind, body }) as DocumentEntity;
  const result = (questions: string[]) =>
    doc('research_result', JSON.stringify({ summary: [], questions, impact: [] }));
  const ids = (documents: DocumentEntity[]) => openItems(run, documents, []).map((item) => item.id);

  it('lists a multi-line question of the research result whole', () => {
    const questions = ['Is it ok?\n  - nested: yes\n1. first', 'second?'];

    expect(ids([doc('questions', renderQuestions(questions)), result(questions)])).toEqual(questions);
  });

  it('lists the questions plan wrote, not the older result of research', () => {
    expect(ids([result(['from research']), doc('questions', '- from plan\n')])).toEqual(['from plan']);
  });

  it('lists the questions of a run stored before results, and none for an empty document', () => {
    expect(ids([doc('questions', '- one?\n- none\n')])).toEqual(['one?']);
    expect(ids([result(['cleared']), doc('questions', '')])).toEqual([]);
  });

  it('lists the subtask questions of a split parent at implement, and not its old research questions', () => {
    const split = { currentStep: 'implement', split: true } as RunEntity;
    const items = (documents: DocumentEntity[]) => openItems(split, documents, []);

    const [item] = items([
      doc('questions', '- from research\n'),
      doc('subtask_questions', '- Subtask a asks: which?\n'),
    ]);
    expect(item).toMatchObject({ kind: 'question', id: 'Subtask a asks: which?', answer: '' });
    expect(items([doc('questions', '- from research\n')])).toEqual([]);
  });

  it('lists the question of a code review waiting for the person, and is ready once it is answered', () => {
    const waiting = { currentStep: 'code-review', status: 'waiting' } as RunEntity;
    const asked = doc(
      'review_questions',
      '- quality still returns: x Implement answered: nothing. Which holds? (asked t)\n',
    );
    const items = openItems(waiting, [asked], []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'question', answer: '' });
    expect(stateView(waiting, items, [asked]).reason?.code).toBe('NEEDS_ANSWERS');
    expect(resumeState(waiting, items, [asked])).toBe('need-answers');
    const answers = doc('answers', `question: ${items[0].id}\nanswer: keep it\n`);
    const answered = openItems(waiting, [asked, answers], []);
    expect(answered[0].answer).toBe('keep it');
    expect(resumeState(waiting, answered, [asked, answers])).toBe('ready');
    expect(openItems(waiting, [asked, doc('review_questions', '')], [])).toEqual([]);
  });
});
