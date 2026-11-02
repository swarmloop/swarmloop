import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeNames } from './names.ts';

describe('mergeNames', () => {
  it('appends names that are not already present, in incoming order', () => {
    assert.deepEqual(mergeNames(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
    assert.deepEqual(mergeNames([], ['a', 'a']), ['a']);
    assert.deepEqual(mergeNames(['b'], ['a']), ['b', 'a']);
  });
});
