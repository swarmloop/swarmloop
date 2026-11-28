import { askPerson, partsOfOpen } from './person-questions';
import { askedParts, type AnsweredQuestion, type StoredQuestion } from './question-parts';

const AT = '2026-11-28T10:00:00.000Z';

function ask(asker: string, decide: string, line = `${asker} asks: ${decide}`): StoredQuestion {
  return { question: line, parts: askedParts(decide, AT, { asker }) };
}

describe('askPerson', () => {
  it('adds a new question once and keeps the parts of the open lines', () => {
    const open = ask('subtask:a', 'Which one?');
    const next = ask('subtask:b', 'Which other?');
    const first = askPerson({ lines: [open.question], parts: [open], answered: [] }, next);

    expect(first).toEqual({ kind: 'asked', lines: [open.question, next.question], parts: [open, next] });
    if (first.kind !== 'asked') throw new Error('asked expected');
    expect(askPerson({ lines: first.lines, parts: first.parts, answered: [] }, next)).toEqual(first);
  });

  it('keeps the stored parts of other documents and replaces an earlier entry of the same question', () => {
    const review = ask('reviewer', 'Review?');
    const again = ask('subtask:b', 'Open?');
    const next = { ...again, parts: askedParts('Open? Again', AT, { asker: 'subtask:b' }) };

    expect(askPerson({ lines: [again.question], parts: [review, again], answered: [] }, next)).toEqual({
      kind: 'asked',
      lines: [again.question],
      parts: [review, next],
    });
  });

  it('lists the stored parts of the open lines only', () => {
    const closed = ask('subtask:a', 'Closed?');
    const open = ask('subtask:b', 'Open?');

    expect(partsOfOpen([closed, open], [open.question])).toEqual([open]);
  });

  it('gives the answer of an asker and decision answered before, and adds no line', () => {
    const record: AnsweredQuestion[] = [{ asker: 'subtask:a', decide: 'Which   one?', answer: 'The first', at: AT }];

    expect(askPerson({ lines: [], parts: [], answered: record }, ask('subtask:a', 'Which one?'))).toEqual({
      kind: 'answered',
      answer: 'The first',
    });
  });

  it('asks another asker the same decision', () => {
    const record: AnsweredQuestion[] = [{ asker: 'subtask:a', decide: 'Which one?', answer: 'The first', at: AT }];
    const other = ask('subtask:b', 'Which one?');

    expect(askPerson({ lines: [], parts: [], answered: record }, other)).toEqual({
      kind: 'asked',
      lines: [other.question],
      parts: [other],
    });
  });
});
