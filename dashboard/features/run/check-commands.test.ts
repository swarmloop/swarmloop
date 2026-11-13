import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { CheckCommandView } from '@contract/api';
import { commandCounts, commandLabel, liveCommands } from './check-commands.ts';

const row = (attempt: string, index: number, status: CheckCommandView['status'], name: string | null = null) =>
  ({
    attempt,
    index,
    repo: 'api',
    command: `cmd ${index}`,
    name,
    status,
    startedAt: null,
    endedAt: null,
    exitCode: null,
  }) as CheckCommandView;

describe('liveCommands', () => {
  it('replaces the step view rows of the live attempt and keeps the others', () => {
    const merged = liveCommands(
      [row('a1', 0, 'failed'), row('a2', 0, 'waiting')],
      [row('a2', 0, 'running'), row('a2', 1, 'waiting')],
    );

    assert.deepEqual(
      merged.map((item) => [item.attempt, item.index, item.status]),
      [
        ['a1', 0, 'failed'],
        ['a2', 0, 'running'],
        ['a2', 1, 'waiting'],
      ],
    );
  });

  it('returns the step view rows when the flow has none', () => {
    assert.deepEqual(liveCommands([row('a1', 0, 'passed')], undefined), [row('a1', 0, 'passed')]);
  });
});

describe('commandCounts', () => {
  it('counts a skipped command as passed and a waiting one as queued', () => {
    const rows = ['passed', 'skipped', 'failed', 'running', 'waiting', 'waiting'].map((status, index) =>
      row('a1', index, status as CheckCommandView['status']),
    );

    assert.deepEqual(commandCounts(rows), { passed: 2, failed: 1, running: 1, queued: 2, total: 6 });
  });
});

describe('commandLabel', () => {
  it('is the name, or the command line for a row without one', () => {
    assert.equal(commandLabel(row('a1', 0, 'passed', 'unit')), 'unit');
    assert.equal(commandLabel(row('a1', 3, 'passed')), 'cmd 3');
  });
});
