import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { CheckCommandView } from '@contract/api';
import {
  commandCounts,
  commandLabel,
  commandSummary,
  liveCommands,
  skipKey,
  skippedLast,
  skipReasons,
  waitsForSlot,
} from './check-commands.ts';

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
  it('counts a skipped command apart from the passed ones and a waiting one as queued', () => {
    const rows = ['passed', 'skipped', 'failed', 'running', 'waiting', 'waiting'].map((status, index) =>
      row('a1', index, status as CheckCommandView['status']),
    );

    assert.deepEqual(commandCounts(rows), { passed: 1, skipped: 1, failed: 1, running: 1, queued: 2, total: 6 });
  });

  it('gives 4 skipped and 8 waiting no passed and 4 skipped, over the 8 that run', () => {
    const rows = [...Array(4).fill('skipped'), ...Array(8).fill('waiting')].map((status, index) =>
      row('a1', index, status as CheckCommandView['status']),
    );

    assert.deepEqual(commandCounts(rows), { passed: 0, skipped: 4, failed: 0, running: 0, queued: 8, total: 12 });
    assert.deepEqual(
      { ...commandSummary(rows, 0), slowest: null },
      { passed: 0, total: 8, skipped: 4, waitsForSlot: true, slowest: null },
    );
  });
});

describe('waitsForSlot', () => {
  it('holds only with no running command and at least one waiting', () => {
    assert.equal(waitsForSlot([row('a', 0, 'skipped'), row('a', 1, 'waiting')]), true);
    assert.equal(waitsForSlot([row('a', 0, 'running'), row('a', 1, 'waiting')]), false);
    assert.equal(waitsForSlot([row('a', 0, 'passed'), row('a', 1, 'skipped')]), false);
  });
});

describe('skippedLast', () => {
  it('puts skipped rows after the others and keeps the order inside each group', () => {
    const rows = [row('a', 0, 'skipped'), row('a', 1, 'running'), row('a', 2, 'skipped'), row('a', 3, 'waiting')];

    assert.deepEqual(
      skippedLast(rows).map((item) => item.index),
      [1, 3, 0, 2],
    );
  });
});

describe('skipReasons', () => {
  const document = (kind: string, body: string) => ({ kind, attempt: 1, body, createdAt: '2026-01-01T00:00:00.000Z' });

  it('maps a skip record to its tail by repo and command, and ignores other documents and a broken body', () => {
    const reasons = skipReasons([
      document(
        'checks',
        JSON.stringify({ repo: 'api', command: 'cmd 0', skipped: true, tail: 'no change in its paths' }),
      ),
      document('checks', JSON.stringify({ repo: 'api', command: 'cmd 1', skipped: false, tail: 'ran' })),
      document('checks', 'not json'),
      document('log', JSON.stringify({ repo: 'api', command: 'cmd 2', skipped: true, tail: 'x' })),
    ]);

    assert.deepEqual(reasons, { [skipKey(row('a', 0, 'skipped'))]: 'no change in its paths' });
  });
});

describe('commandLabel', () => {
  it('is the name, or the command line for a row without one', () => {
    assert.equal(commandLabel(row('a1', 0, 'passed', 'unit')), 'unit');
    assert.equal(commandLabel(row('a1', 3, 'passed')), 'cmd 3');
  });
});
