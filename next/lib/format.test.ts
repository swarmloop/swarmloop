import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tokens } from './format.ts';

describe('tokens', () => {
  it('shows an integer under 1,000 and the nearest thousand as k', () => {
    assert.equal(tokens(0), '0');
    assert.equal(tokens(999), '999');
    assert.equal(tokens(1000), '1k');
    assert.equal(tokens(1499), '1k');
    assert.equal(tokens(1500), '2k');
    assert.equal(tokens(777_326), '777k');
    assert.equal(tokens(999_499), '999k');
  });

  it('shows one decimal million and drops a trailing .0', () => {
    assert.equal(tokens(999_500), '1M');
    assert.equal(tokens(1_000_000), '1M');
    assert.equal(tokens(1_200_000), '1.2M');
    assert.equal(tokens(1_050_000), '1.1M');
    assert.equal(tokens(2_000_000), '2M');
  });
});
