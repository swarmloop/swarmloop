import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openElapsed, openRunMs, visitStored } from './elapsed.ts';

const start = '2020-01-01T00:00:00.000Z';
const now = Date.parse(start) + 1500;

describe('openElapsed', () => {
  it('counts time since a start and stays at zero when the start is missing or ahead', () => {
    assert.equal(openElapsed(start, now), 1500);
    assert.equal(openElapsed(null, now), 0);
    assert.equal(openElapsed('', now), 0);
    assert.equal(openElapsed('nope', now), 0);
    assert.equal(openElapsed(new Date(now + 5000).toISOString(), now), 0);
  });
});

describe('openRunMs', () => {
  it('counts only a running step', () => {
    assert.equal(openRunMs({ status: 'running', stepStartedAt: start }, now), 1500);
    assert.equal(openRunMs({ status: 'running', stepStartedAt: null }, now), 0);
    assert.equal(openRunMs({ status: 'failed', stepStartedAt: start }, now), 0);
    assert.equal(openRunMs({ status: 'running', stepStartedAt: 'nope' }, now), 0);
  });
});

describe('visitStored', () => {
  it('is true only when the held start is already in the closed list', () => {
    assert.equal(visitStored(['a', 'b'], 'b'), true);
    assert.equal(visitStored(['a'], 'b'), false);
    assert.equal(visitStored(['a'], null), false);
  });
});
