import type { DocumentEntity, RunEntity } from '../../history/entities';
import { renderQuestions } from '../../steps/research/research-record';
import { storedState, writeOpenItemState } from '../../history/run-state';
import { resumeState } from './flow-waiting';
import { openItems } from '../../steps/shared/open-items';

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

  it('gives a research or plan question without stored parts item-only parts of its step and document', () => {
    const asked = { kind: 'questions', body: '- one?\n', createdAt: 't1' } as DocumentEntity;
    const parts = (step: string) => openItems({ currentStep: step } as RunEntity, [asked], [])[0].parts;

    expect(parts('research')).toEqual({ decide: 'one?', sides: [], full: '', askedAt: 't1', asker: 'research' });
    expect(parts('plan')?.asker).toBe('plan');
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

  it('lists a question the planner escalated at implement with its parts, and not an old one without parts', () => {
    const implementing = { currentStep: 'implement', status: 'waiting' } as RunEntity;
    const line = 'implement asks: Which pagination? (asked t)';
    const parts = { decide: 'Which pagination?', sides: [], full: '', askedAt: 't' };
    const documents = [
      doc('questions', `- from research\n- ${line}\n`),
      doc('question_parts', JSON.stringify([{ question: line, parts }])),
    ];
    const items = openItems(implementing, documents, []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'question', id: line, answer: '', parts });
  });

  it('lists an escalated question at any step after plan, and not a line without stored parts', () => {
    const line = 'implement asks: Which pagination? (asked t)';
    const parts = { decide: 'Which pagination?', sides: [], full: '', askedAt: 't' };
    const documents = [
      doc('questions', `- old line\n- ${line}\n`),
      doc('question_parts', JSON.stringify([{ question: line, parts }])),
    ];
    for (const currentStep of ['plan-improve', 'merge-request'] as const) {
      const items = openItems({ currentStep, status: 'waiting' } as RunEntity, documents, []);
      expect(items.map((item) => item.id)).toEqual([line]);
    }
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
    const held = { ...waiting };
    writeOpenItemState(held, { needsAnswers: items.length > 0 });
    expect(storedState(held).reason?.code).toBe('NEEDS_ANSWERS');
    expect(resumeState(waiting, items)).toBe('need-answers');
    const answers = doc('answers', `question: ${items[0].id}\nanswer: keep it\n`);
    const answered = openItems(waiting, [asked, answers], []);
    expect(answered[0].answer).toBe('keep it');
    expect(resumeState(waiting, answered)).toBe('ready');
    expect(openItems(waiting, [asked, doc('review_questions', '')], [])).toEqual([]);
  });

  it('attaches the stored parts to the question they belong to, and none to an unmatched one', () => {
    const waiting = { currentStep: 'code-review', status: 'waiting' } as RunEntity;
    const parts = { decide: 'Is it?', sides: [{ who: 'implement', text: 'No answer' }], full: 'all', askedAt: 't' };
    const kept = [{ question: 'review ask (asked t)', parts }];
    const asked = doc('review_questions', '- review ask (asked t)\n- old ask (asked s)\n');

    const items = openItems(waiting, [asked, doc('question_parts', JSON.stringify(kept))], []);
    expect(items[0].parts).toEqual(parts);
    expect(items[1].parts).toEqual({
      decide: 'old ask (asked s)',
      sides: [],
      full: '',
      askedAt: '',
      asker: 'code-review',
    });

    const split = { currentStep: 'implement', split: true } as RunEntity;
    const subtask = doc('subtask_questions', '- Subtask a asks: which? (asked t)\n');
    const own = [{ question: 'Subtask a asks: which? (asked t)', parts }];
    expect(openItems(split, [subtask, doc('question_parts', JSON.stringify(own))], [])[0].parts).toEqual(parts);
    expect(openItems(split, [subtask, doc('question_parts', 'not json')], [])[0].parts).toMatchObject({
      sides: [],
      asker: 'implement',
    });
  });

  it('carries who asked and the plan chat entry of a stored question', () => {
    const waiting = { currentStep: 'code-review', status: 'waiting' } as RunEntity;
    const parts = {
      decide: 'Is it?',
      sides: [],
      full: '',
      askedAt: 't',
      asker: 'code-review-quality',
      entry: 'escalate-ask-1',
    };
    const asked = doc('review_questions', '- review ask (asked t)\n');
    const kept = doc('question_parts', JSON.stringify([{ question: 'review ask (asked t)', parts }]));

    const [item] = openItems(waiting, [asked, kept], []);

    expect(item.parts?.asker).toBe('code-review-quality');
    expect(item.parts?.entry).toBe('escalate-ask-1');
  });
});
