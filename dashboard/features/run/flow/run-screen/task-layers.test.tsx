import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TaskLayer } from '@contract/api';
import type { RunState } from '@contract/run-state';
import type { SubtaskStatus } from '@contract/subtask';
import { RunList } from '../../../runs';
import { runSummary } from '../../../../test/fixtures';
import { TaskLayers } from './task-layers';

const manyFiles = Array.from({ length: 16 }, (_, index) => `server/src/file-${index}.ts`);
const task = (id: string, extra: Partial<TaskLayer['tasks'][number]> = {}): TaskLayer['tasks'][number] => ({
  id,
  title: `Title ${id}`,
  files: [`${id}.ts`],
  proof: `${id}.spec.ts passes`,
  depends: [],
  status: 'merged',
  run: { key: `run-1-${id}`, state: 'merged', currentStep: 'done', usd: 1.5, durationMs: 65000 },
  ...extra,
});
const layers: TaskLayer[] = [
  { layer: 0, tasks: [task('t1', { files: manyFiles, proof: 'The `parse` call works' }), task('t2')] },
  {
    layer: 1,
    tasks: [
      task('t3', {
        depends: ['t1'],
        status: 'running',
        run: { key: 'run-1-t3', state: 'running', currentStep: 'code-review', usd: 0.25, durationMs: 5000 },
      }),
      task('t4', { depends: ['t1', 't2'] }),
      task('t5', { status: 'blocked', run: undefined }),
    ],
  },
  {
    layer: 2,
    tasks: [task('t6', { depends: ['t3'], status: 'waiting', run: undefined }), task('t7', { depends: ['t4'] })],
  },
];

describe('TaskLayers', () => {
  it('shows per task its step, own cost, time and a link to its run', () => {
    render(<TaskLayers layers={layers} onSkip={vi.fn()} />);

    const region = screen.getByRole('region', { name: 'Tasks' });
    for (let id = 1; id <= 7; id += 1) {
      expect(region).toHaveTextContent(`Title t${id}`);
    }
    expect(region).toHaveTextContent('running · code review');
    expect(region).toHaveTextContent('after t1');
    expect(region).toHaveTextContent('5s · $0.25');
    expect(within(region).getByRole('link', { name: 'Open run Title t3' })).toHaveAttribute('href', '/runs/run-1-t3');
    expect(within(region).queryByRole('link', { name: 'Open run Title t5' })).not.toBeInTheDocument();
  });

  it('lists blocked, running, waiting, then settled tasks, in plan order inside a group', () => {
    render(<TaskLayers layers={layers} onSkip={vi.fn()} />);

    const titles = within(screen.getByRole('region', { name: 'Tasks' }))
      .getAllByText(/^Title t\d$/)
      .map((node) => node.textContent);
    expect(titles).toEqual(['Title t5', 'Title t3', 'Title t6', 'Title t1', 'Title t2', 'Title t4', 'Title t7']);
  });

  it('sums the subtasks in one summary line', () => {
    render(<TaskLayers layers={layers} onSkip={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'Tasks' })).toHaveTextContent('7 tasks · 4 merged · 4m 25s · $6.25');
    expect(screen.getByRole('progressbar', { name: 'Merged' })).toBeInTheDocument();
  });

  it('keeps files and proof closed until the row is opened', async () => {
    render(<TaskLayers layers={layers} onSkip={vi.fn()} />);

    expect(screen.queryByText('server/src/file-0.ts')).not.toBeInTheDocument();
    expect(screen.queryByText(/passes/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '16 files · proof' }));

    expect(screen.getAllByText(/server\/src\/file-/)).toHaveLength(16);
    expect(screen.getByText('parse').tagName).toBe('CODE');
  });

  it('skips a blocked task', async () => {
    const onSkip = vi.fn();
    render(<TaskLayers layers={layers} onSkip={onSkip} />);

    await userEvent.click(screen.getByRole('button', { name: 'Skip task' }));

    expect(onSkip).toHaveBeenCalledWith('t5');
  });

  it('shows the merge queue and the decisions, and hides them when empty', () => {
    const { rerender } = render(
      <TaskLayers
        layers={layers}
        mergeQueue={[{ id: 't3', title: 'Send it' }]}
        decisions="- subtask a: use `UTC`"
        onSkip={vi.fn()}
      />,
    );

    expect(within(screen.getByRole('region', { name: 'Merge queue' })).getByText('Send it')).toBeInTheDocument();
    const decisions = screen.getByRole('region', { name: 'Decisions' });
    expect(decisions).toHaveTextContent('Decisions');
    expect(within(decisions).getByText('UTC').tagName).toBe('CODE');

    rerender(<TaskLayers layers={layers} onSkip={vi.fn()} />);

    expect(screen.queryByRole('region', { name: 'Merge queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Decisions' })).not.toBeInTheDocument();
  });

  it('gives the same task order in the run list and in the Tasks section', async () => {
    const parent = {
      ...runSummary(),
      key: 'e-1',
      name: 'Epic parent',
      taskCounts: { merged: 1, running: 1, blocked: 1 },
    };
    const subtask = (id: string, index: number, status: SubtaskStatus, state: RunState) => ({
      ...runSummary(),
      key: `e-1-${id}`,
      name: `Task ${id}`,
      parentKey: 'e-1',
      taskId: id,
      state,
      task: { index, status },
    });
    const merged = subtask('A', 0, 'merged', 'merged');
    const running = subtask('B', 1, 'running', 'running');
    const blocked = {
      ...subtask('C', 2, 'blocked', 'blocked'),
      stateReason: { code: 'BLOCKED', message: 'Needs you' },
    };
    const runs = [parent, merged, running, blocked];
    const titles = () => screen.getAllByText(/^Task [ABC]$/).map((node) => node.textContent);
    render(
      <RunList
        query=""
        onQuery={vi.fn()}
        runs={runs}
        visible={runs}
        selected=""
        now={0}
        error={null}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^✓ 1 merged/ }));
    const inList = titles();
    cleanup();

    const planned = [merged, running, blocked].map((run) => ({
      id: run.taskId,
      title: run.name,
      files: [],
      proof: '',
      depends: [],
      status: run.task.status,
    }));
    render(<TaskLayers layers={[{ layer: 0, tasks: planned }]} onSkip={vi.fn()} />);

    expect(inList).toEqual(['Task C', 'Task B', 'Task A']);
    expect(titles()).toEqual(inList);
  });
});
