import { unanswered } from './shared/answers';

describe('answers', () => {
  it('keeps a question until it has an answer', () => {
    const questions = '- which limit\n- which repo\n';
    expect(unanswered(questions, '')).toEqual(['which limit', 'which repo']);
    expect(unanswered(questions, 'question: which limit\nanswer: three\n')).toEqual(['which repo']);
    expect(unanswered(questions, 'question: which limit\nanswer: three\n\nquestion: which repo\nanswer: demo\n')).toEqual([]);
  });
});