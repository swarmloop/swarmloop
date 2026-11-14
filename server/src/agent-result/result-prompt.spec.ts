import { resultFollowUp } from './result-follow-up';
import { RESULT_AS_BEFORE, resultPrompt, resultPromptFor } from './result-prompt';
import { sample } from './result.spec-helpers';

describe('resultPrompt', () => {
  it('lists every field with its type, whether it is required, and its description', () => {
    const text = resultPrompt(sample);
    expect(text).toContain('- title (string, required): A short title');
    expect(text).toContain('- items (array of string, required): One entry per line');
    expect(text).toContain('- decision (one of "ok", "return", required): The verdict');
    expect(text).toContain('- note (string, optional): Anything else');
    expect(text).toContain('- tasks[].id (string, required): The task id');
  });
});

describe('resultPromptFor', () => {
  it('gives the full text for a new chat and for a different definition', () => {
    expect(resultPromptFor(sample, null)).toBe(resultPrompt(sample));
    expect(resultPromptFor(sample, 'other')).toBe(resultPrompt(sample));
  });

  it('gives one line for a definition the chat already received', () => {
    expect(resultPromptFor(sample, 'sample')).toBe(RESULT_AS_BEFORE);
  });
});

describe('resultFollowUp', () => {
  it('holds every error and the one line, and no schema', () => {
    const text = resultFollowUp(['a: bad', 'b: worse']);
    expect(text).toContain('- a: bad');
    expect(text).toContain('- b: worse');
    expect(text).toContain(RESULT_AS_BEFORE);
    expect(text).not.toContain('(string');
  });
});
