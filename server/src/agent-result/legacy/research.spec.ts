import { legacyQuestions } from './research';

describe('legacyQuestions', () => {
  it('reads a stored questions document', () => {
    expect(legacyQuestions('- a?\n- none\n- b?\n')).toEqual(['a?', 'b?']);
    expect(legacyQuestions('')).toEqual([]);
  });
});
