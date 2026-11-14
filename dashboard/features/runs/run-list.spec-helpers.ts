import { render } from '@testing-library/react';
import { createElement } from 'react';
import type { ComponentProps } from 'react';
import { vi } from 'vitest';
import type { RunSummary } from '@contract/api';
import { ERROR_CODES } from '@contract/error-codes';
import { REASON } from '@contract/run-state';
import type { SubtaskStatus } from '@contract/subtask';
import { runSummary } from '../../test/fixtures';
import { RunList } from './run-list';

/** Local noon on 12 Nov 2026, so the day headers do not depend on the time zone. */
export const NOW = new Date(2026, 10, 12, 12).getTime();
export const TODAY = new Date(2026, 10, 12, 11).toISOString();
export const YESTERDAY = new Date(2026, 10, 11, 15).toISOString();

export function listRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return { ...runSummary(), updatedAt: TODAY, createdAt: TODAY, ...overrides };
}

const MERGED_FACT = { sha: 'abcdef123456', by: 'ada', at: '2026-05-01T10:00:00.000Z', url: null };

/** One run per state the list words, with the word its line 2 starts with. */
export const STATE_RUNS: { word: string; run: RunSummary }[] = [
  { word: 'Working', run: listRun({ key: 's-working', name: 'Working run', state: 'running' }) },
  {
    word: 'Waiting for you',
    run: listRun({
      key: 's-answer',
      name: 'Answer run',
      status: 'waiting',
      state: 'waiting',
      stateReason: { code: 'NEEDS_ANSWERS', message: 'Questions are open' },
    }),
  },
  {
    word: 'Paused until',
    run: listRun({
      key: 's-paused',
      name: 'Paused run',
      status: 'waiting',
      state: 'waiting',
      stateReason: {
        code: ERROR_CODES.RUNTIME_LIMIT,
        message: 'Usage limit',
        limit: { runtime: 'claude', resumesAt: '2026-11-12T15:00:00.000Z' },
      },
    }),
  },
  {
    word: 'Retrying at',
    run: listRun({
      key: 's-retry',
      name: 'Retry run',
      status: 'waiting',
      state: 'waiting',
      stateReason: { code: ERROR_CODES.HOST_UNAVAILABLE, message: 'Host is down', retryAt: '2026-11-12T13:00:00.000Z' },
    }),
  },
  {
    word: 'Waiting for subtasks',
    run: listRun({
      key: 's-subtasks',
      name: 'Subtasks run',
      status: 'waiting',
      state: 'waiting',
      stateReason: { code: ERROR_CODES.SUBTASKS_RUNNING, message: 'Subtasks are running' },
    }),
  },
  {
    word: 'Blocked',
    run: listRun({
      key: 's-blocked',
      name: 'Blocked run',
      status: 'blocked',
      state: 'blocked',
      stateReason: { code: REASON.blocked, message: 'Needs a decision' },
    }),
  },
  {
    word: 'Failed',
    run: listRun({
      key: 's-failed',
      name: 'Failed run',
      status: 'failed',
      state: 'failed',
      stateReason: { code: ERROR_CODES.STEP_FAILED, message: 'The step failed' },
    }),
  },
  { word: 'Stopped', run: listRun({ key: 's-stopped', name: 'Stopped run', status: 'waiting', state: 'stopped' }) },
  {
    word: 'Ready to merge',
    run: listRun({ key: 's-ready', name: 'Ready run', status: 'done', currentStep: 'done', state: 'done' }),
  },
  {
    word: 'Merged',
    run: listRun({
      key: 's-merged',
      name: 'Merged run',
      status: 'done',
      currentStep: 'done',
      state: 'merged',
      durationMs: 56 * 60_000,
      usd: 4.06,
      merge: { merged: { 'acme/demo': MERGED_FACT } },
    }),
  },
  {
    word: 'Closed',
    run: listRun({
      key: 's-closed',
      name: 'Closed run',
      status: 'done',
      currentStep: 'done',
      state: 'closed',
      merge: { closed: { repo: 'acme/demo', by: 'grace', at: '2026-05-02T08:00:00.000Z' } },
    }),
  },
];

/** An epic of three tasks, merged, running and blocked, listed out of plan order. */
export function epicOfThree(): { parent: RunSummary; merged: RunSummary; running: RunSummary; blocked: RunSummary } {
  const task = (id: string, index: number, status: SubtaskStatus, overrides: Partial<RunSummary>): RunSummary =>
    listRun({
      key: `e-1-${id}`,
      name: `Task ${id}`,
      parentKey: 'e-1',
      taskId: id,
      task: { index, status },
      ...overrides,
    });
  return {
    parent: listRun({
      key: 'e-1',
      name: 'Epic parent',
      status: 'waiting',
      state: 'waiting',
      stateReason: { code: ERROR_CODES.SUBTASKS_RUNNING, message: 'Subtasks are running' },
      usd: 1,
      epic: { usd: 14.88, durationMs: 126 * 60_000 },
      taskCounts: { merged: 1, running: 1, blocked: 1 },
    }),
    merged: task('A', 0, 'merged', {
      status: 'done',
      state: 'merged',
      usd: 3,
      merge: { merged: { 'acme/demo': MERGED_FACT } },
    }),
    running: task('B', 1, 'running', { state: 'running', usd: 0.5 }),
    blocked: task('C', 2, 'blocked', {
      status: 'blocked',
      state: 'blocked',
      stateReason: { code: REASON.blocked, message: 'Needs a decision' },
    }),
  };
}

/** The props of the list for the given runs, all of them visible, with every handler a spy. */
function listProps(runs: RunSummary[], overrides: Partial<ComponentProps<typeof RunList>> = {}) {
  return {
    query: '',
    onQuery: vi.fn(),
    runs,
    visible: runs,
    part: 'active' as const,
    otherMatches: 0,
    onPart: vi.fn(),
    selected: '',
    now: NOW,
    error: null,
    onOpen: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
}

export function renderList(runs: RunSummary[], overrides: Partial<ComponentProps<typeof RunList>> = {}) {
  const props = listProps(runs, overrides);
  render(createElement(RunList, props));
  return props;
}
