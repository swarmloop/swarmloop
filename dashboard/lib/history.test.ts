import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { documentsByKind, tokensByModel } from './history.ts';

describe('documentsByKind', () => {
  it('groups by kind in first-seen order', () => {
    assert.deepEqual(documentsByKind([]), []);
    assert.deepEqual(
      documentsByKind([
        { kind: 'log', attempt: 1 },
        { kind: 'plan', attempt: 1 },
        { kind: 'log', attempt: 2 },
      ]),
      [
        ['log', [{ kind: 'log', attempt: 1 }, { kind: 'log', attempt: 2 }]],
        ['plan', [{ kind: 'plan', attempt: 1 }]],
      ],
    );
  });
});

describe('tokensByModel', () => {
  it('sums tokens by model and uses none when the model is missing', () => {
    assert.deepEqual(
      tokensByModel([
        { model: 'gpt', tokensIn: 1, tokensOut: 2 },
        { model: null, tokensIn: 3, tokensOut: 4 },
        { model: 'gpt', tokensIn: 5, tokensOut: 6 },
        { model: null, tokensIn: 7, tokensOut: 8 },
      ]),
      [
        ['gpt', { inn: 6, out: 8 }],
        ['none', { inn: 10, out: 12 }],
      ],
    );
  });
});
