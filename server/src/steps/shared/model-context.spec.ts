import { modelContextTokens } from './model-context';

describe('modelContextTokens', () => {
  it('gives the context window of a known model', () => {
    expect(modelContextTokens('claude', 'claude-opus-5-5')).toBe(1_000_000);
  });

  it('gives null for an unknown model', () => {
    expect(modelContextTokens('claude', 'claude-unknown')).toBeNull();
  });

  it('gives null for a null runtime', () => {
    expect(modelContextTokens(null, 'claude-opus-5-5')).toBeNull();
  });
});
