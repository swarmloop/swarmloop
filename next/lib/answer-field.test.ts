import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { answerPresentation } from './answer-field.ts';

describe('answerPresentation', () => {
  it('shows a question above the field with no floating label', () => {
    assert.deepEqual(answerPresentation({ kind: 'question', label: 'Which branch should we use?' }), {
      heading: 'Which branch should we use?',
      label: null,
    });
  });

  it('keeps the floating label for a paste item with no text above', () => {
    assert.deepEqual(answerPresentation({ kind: 'paste', label: 'https://example.com/spec' }), {
      heading: null,
      label: 'https://example.com/spec',
    });
  });
});
