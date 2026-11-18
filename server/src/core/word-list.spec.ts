import { wordList } from './word-list';

describe('wordList', () => {
  it('joins names the way a person writes them', () => {
    expect(wordList([])).toBe('');
    expect(wordList(['quality'])).toBe('quality');
    expect(wordList(['quality', 'security'])).toBe('quality and security');
    expect(wordList(['quality', 'regressions', 'security', 'performance'])).toBe(
      'quality, regressions, security and performance',
    );
  });
});
