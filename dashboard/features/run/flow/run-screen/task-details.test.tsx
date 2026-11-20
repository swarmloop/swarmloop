import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TaskEntry } from '@contract/api';
import { TaskRow } from './task-row';

const planned = ['server/src/a.ts', 'server/src/b.ts', 'server/src/c.ts', 'dashboard/d.tsx', 'e.md'];
const entry = (extra: Partial<TaskEntry> = {}): TaskEntry => ({
  id: 't1',
  index: 0,
  title: 'Add the column',
  files: planned,
  proof: 'The `parse` call works',
  depends: [],
  status: 'waiting',
  waitsFor: [],
  ...extra,
});
const open = async (task: TaskEntry, button: string): Promise<void> => {
  render(
    <ul>
      <TaskRow now={0} task={task} dependents={[]} onSkip={vi.fn()} />
    </ul>,
  );
  await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: button }));
};

describe('TaskDetails', () => {
  it('shows the plan of a task that has not started, with no result', async () => {
    await open(entry(), 'Plan');

    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByText('Will change 5 files')).toBeInTheDocument();
    expect(screen.getByText('Done when:')).toBeInTheDocument();
    expect(screen.getByText('parse').tagName).toBe('CODE');
    expect(screen.getByText('a.ts')).toHaveStyle({ fontFamily: 'var(--font-mono)' });
    expect(screen.getByText('dashboard/')).not.toHaveStyle({ fontFamily: 'var(--font-mono)' });
    expect(screen.queryByText(/Changed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Result' })).not.toBeInTheDocument();
  });

  it('shows what a merged task changed, marking files outside the plan and planned files it left alone', async () => {
    const changed = [...planned.slice(0, 3), 'server/src/extra.ts'];
    const run = {
      key: 'run-1-t1',
      state: 'merged' as const,
      currentStep: 'done',
      usd: 1,
      durationMs: 1000,
      result: { files: [...changed, ...Array.from({ length: 9 }, (_, index) => `more/${index}.ts`)], proofMet: true },
    };
    await open(entry({ status: 'merged', waitsFor: undefined, run }), 'Changes · 13 files');

    expect(screen.getByRole('heading', { name: 'Result' })).toBeInTheDocument();
    expect(screen.getByText('Changed 13 files')).toBeInTheDocument();
    expect(screen.getAllByText('not in plan')).toHaveLength(10);
    expect(screen.getAllByText('planned, not changed')).toHaveLength(2);
    expect(screen.getByText('Proof met')).toBeInTheDocument();
  });

  it('says when the proof did not hold', async () => {
    const run = {
      key: 'run-1-t1',
      state: 'blocked' as const,
      currentStep: 'ci',
      usd: 1,
      durationMs: 1000,
      result: { files: ['server/src/a.ts'], proofMet: false },
    };
    await open(entry({ status: 'blocked', waitsFor: undefined, run }), 'Changes · 1 file');

    expect(screen.getByText('Proof not met')).toBeInTheDocument();
  });
});
