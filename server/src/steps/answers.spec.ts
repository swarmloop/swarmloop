import { answered, openQuestions, unanswered } from './shared/answers';
import { renderQuestions } from './research/research-record';

const result = (questions: string[]) => ({ summary: [], questions, impact: [] });

describe('answers', () => {
  it('keeps a question until it has an answer', () => {
    const questions = '- which limit\n- which repo\n';
    expect(unanswered(questions, null, '')).toEqual(['which limit', 'which repo']);
    expect(unanswered(questions, null, 'question: which limit\nanswer: three\n')).toEqual(['which repo']);
    expect(
      unanswered(questions, null, 'question: which limit\nanswer: three\n\nquestion: which repo\nanswer: demo\n'),
    ).toEqual([]);
  });

  it('keeps a multi-line question of the research result whole', () => {
    const questions = ['Is this ok?\n  - nested: yes\n1. first', 'second?'];
    expect(openQuestions(renderQuestions(questions), result(questions))).toEqual(questions);
    expect(unanswered(renderQuestions(questions), result(questions), 'question: second?\nanswer: yes\n')).toEqual([
      questions[0],
    ]);
  });

  it('reads a questions document that plan wrote, whatever research stored', () => {
    expect(openQuestions('- from plan\n', result(['from research']))).toEqual(['from plan']);
  });

  it('gives no open question for an empty document, whatever research stored', () => {
    expect(openQuestions('', result(['cleared by a subtask']))).toEqual([]);
  });

  it('reads the stored questions of a run that has no research result', () => {
    expect(openQuestions('- a\n- none\n', null)).toEqual(['a']);
  });
});

describe('answers to a multi-line question', () => {
  const question = 'Is it ok?\n  - nested: yes\n1. first';
  const stored = `question: ${question}\nanswer: yes, ok\nand more\n\nquestion: second?\nanswer: no\n`;

  it('reads the answer under the whole question, and keeps the other open', () => {
    const questions = [question, 'second?', 'third?'];

    expect(unanswered(renderQuestions(questions), result(questions), stored)).toEqual(['third?']);
    expect(answered(stored).get(question)).toBe('yes, ok\nand more');
  });
});
