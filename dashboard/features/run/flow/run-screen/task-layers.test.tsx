import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RunSummary, TaskEntry } from '@contract/api';
import type { RunState } from '@contract/run-state';
import type { SubtaskStatus } from '@contract/subtask';
import { localTime } from '../../../../lib/format';
import { RunList } from '../../../runs';
import { runSummary } from '../../../../test/fixtures';
import { TaskLayers } from './task-layers';

const manyFiles = Array.from({ length: 16 }, (_, index) => `server/src/file-${index}.ts`);
const task = (id: string, extra: Partial<TaskEntry> = {}): TaskEntry => ({
  id,
  index: Number(id.slice(1)),
  title: `Title ${id}`,
  files: [`${id}.ts`],
  proof: `${id}.spec.ts passes`,
  depends: [],
  status: 'merged',
  run: { key: `run-1-${id}`, state: 'merged', currentStep: 'done', usd: 1.5, durationMs: 65000 },
  ...extra,
});
const tasks: TaskEntry[] = [
  task('t1', { files: manyFiles, proof: 'The `parse` call works' }),
  task('t2'),
  task('t3', {
    depends: ['t1'],
    status: 'running',
    run: { key: 'run-1-t3', state: 'running', currentStep: 'code-review', usd: 0.25, durationMs: 5000 },
  }),
  task('t4', { depends: ['t1', 't2'] }),
  task('t5', { status: 'blocked', run: undefined }),
  task('t6', { depends: ['t3'], status: 'waiting', waitsFor: ['Title t3'], run: undefined }),
  task('t7', { depends: ['t4'] }),
];

const openSettled = async (): Promise<void> =>
  userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: /^✓ \d+ merged/ }));

function renderRunList(runs: RunSummary[]): void {
  render(
    <RunList
      query=""
      onQuery={vi.fn()}
      runs={runs}
      visible={runs}
      part="active"
      otherMatches={0}
      onPart={vi.fn()}
      selected=""
      now={0}
      error={null}
      onOpen={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
}

describe('TaskLayers', () => {
  it('shows per task its step, own cost, time and a link to its run', async () => {
    render(<TaskLayers tasks={tasks} onSkip={vi.fn()} />);
    await openSettled();

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

  it('shows the sentence of a subtask a server restart cut, and none for the others', () => {
    const at = '2026-01-01T10:00:00.000Z';
    const cut = task('t3', {
      status: 'running',
      run: {
        key: 'run-1-t3',
        state: 'running',
        currentStep: 'checks',
        usd: 0,
        durationMs: 0,
        interruption: { at, relaunched: true },
      },
    });
    render(<TaskLayers tasks={[cut, task('t4')]} onSkip={vi.fn()} />);

    const region = screen.getByRole('region', { name: 'Tasks' });
    expect(region).toHaveTextContent(
      `Interrupted at ${localTime(at)} by a server restart. The server starts this step again by itself. Nothing to do.`,
    );
    expect(region.textContent?.match(/Interrupted at/g)).toHaveLength(1);
  });

  it('lists blocked, running, waiting, then settled tasks, in plan order inside a group', async () => {
    render(<TaskLayers tasks={tasks} onSkip={vi.fn()} />);
    await openSettled();

    const titles = within(screen.getByRole('region', { name: 'Tasks' }))
      .getAllByText(/^Title t\d$/)
      .map((node) => node.textContent);
    expect(titles).toEqual(['Title t5', 'Title t3', 'Title t6', 'Title t1', 'Title t2', 'Title t4', 'Title t7']);
  });

  it('sums the tasks in one summary line from the epic figures', () => {
    render(<TaskLayers tasks={tasks} epic={{ usd: 9, durationMs: 1000 }} ownUsd={2.75} onSkip={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'Tasks' })).toHaveTextContent('7 tasks · 4 merged · $6.25');
    expect(screen.getByRole('progressbar', { name: 'Merged' })).toBeInTheDocument();
  });

  it('keeps files and proof closed until the row is opened', async () => {
    render(<TaskLayers tasks={tasks} onSkip={vi.fn()} />);
    await openSettled();

    expect(screen.queryByText('file-0.ts')).not.toBeInTheDocument();
    expect(screen.queryByText(/passes/)).not.toBeInTheDocument();

    const row = screen.getByText('Title t1').closest('li')!;
    await userEvent.setup({ delay: null }).click(within(row).getByRole('button', { name: 'Plan' }));

    expect(screen.getAllByText(/^file-\d+\.ts$/)).toHaveLength(16);
    expect(screen.getByText('parse').tagName).toBe('CODE');
  });

  it('shows the f54 shape: running, waiting, then one folded line for merged and skipped, with real waits', async () => {
    const run = (id: string, state: RunState, step: string) => ({
      key: `run-1-${id}`,
      state,
      currentStep: step,
      usd: 1,
      durationMs: 3_600_000,
    });
    const settled = (id: string, status: SubtaskStatus) =>
      task(id, { status, run: run(id, status === 'merged' ? 'merged' : 'skipped', 'done') });
    const f54 = [
      ...['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((id) => settled(id, 'merged')),
      settled('s1', 'skipped'),
      ...['r1', 'r2', 'r3'].map((id) => task(id, { status: 'running', run: run(id, 'running', 'implement') })),
      task('w1', { depends: ['m1', 'r1'], status: 'waiting', waitsFor: ['Title r1'], run: undefined }),
      task('w2', { depends: ['r2', 'r3'], status: 'waiting', waitsFor: ['Title r2', 'Title r3'], run: undefined }),
      task('w3', { depends: ['m2'], status: 'waiting', waitsFor: [], run: undefined }),
    ].map((item, index) => ({ ...item, index }));
    render(<TaskLayers tasks={f54} epic={{ usd: 20, durationMs: 1000 }} ownUsd={5} onSkip={vi.fn()} />);

    const region = screen.getByRole('region', { name: 'Tasks' });
    expect(region).not.toHaveTextContent('Stage');
    expect(within(region).getByText('13 tasks · 6 merged · $15.00')).toBeInTheDocument();
    expect(region).toHaveTextContent('waiting for Title r1');
    expect(region).toHaveTextContent('waiting for Title r2, Title r3');
    expect(region).toHaveTextContent('waiting for a free slot');
    expect(region).not.toHaveTextContent('waiting for Title m');
    expect(region).toHaveTextContent('after m2');
    const titles = () =>
      within(region)
        .getAllByText(/^Title [rwms]\d$/)
        .map((node) => node.textContent);
    expect(titles()).toEqual(['Title r1', 'Title r2', 'Title r3', 'Title w1', 'Title w2', 'Title w3']);

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: '✓ 6 merged · 1 skipped' }));

    expect(titles().slice(6)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 's1'].map((id) => `Title ${id}`));
  });

  it('puts the agent time in the tooltip of the summary', async () => {
    render(<TaskLayers tasks={tasks} epic={{ usd: 9, durationMs: 1000 }} ownUsd={2.75} onSkip={vi.fn()} />);

    await userEvent.setup({ delay: null }).hover(screen.getByText('7 tasks · 4 merged · $6.25'));

    expect(await screen.findByRole('tooltip')).toHaveTextContent('agents worked 4m 25s');
  });

  it('says once what a waiting task waits for, not the note the split stored as well', () => {
    const waiting = task('t6', {
      status: 'waiting',
      waitsFor: [],
      note: 'waiting for a free slot: 3 of SUBTASKS_PARALLEL running',
      run: undefined,
    });
    render(<TaskLayers tasks={[waiting]} onSkip={vi.fn()} />);

    const region = screen.getByRole('region', { name: 'Tasks' });
    expect(region.textContent?.match(/waiting for/g)).toHaveLength(1);
    expect(region).not.toHaveTextContent('SUBTASKS_PARALLEL');
  });

  it('skips a blocked task', async () => {
    const onSkip = vi.fn();
    render(<TaskLayers tasks={tasks} onSkip={onSkip} />);

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Skip task' }));

    expect(onSkip).toHaveBeenCalledWith('t5', []);
  });

  it('shows the merge queue and the decisions, and hides them when empty', () => {
    const { rerender } = render(
      <TaskLayers
        tasks={tasks}
        mergeQueue={[{ id: 't3', title: 'Send it' }]}
        decisions="- subtask a: use `UTC`"
        onSkip={vi.fn()}
      />,
    );

    expect(within(screen.getByRole('region', { name: 'Merge queue' })).getByText('Send it')).toBeInTheDocument();
    const decisions = screen.getByRole('region', { name: 'Decisions' });
    expect(decisions).toHaveTextContent('Decisions');
    expect(within(decisions).getByText('UTC').tagName).toBe('CODE');

    rerender(<TaskLayers tasks={tasks} onSkip={vi.fn()} />);

    expect(screen.queryByRole('region', { name: 'Merge queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Decisions' })).not.toBeInTheDocument();
  });

  it('gives the same task order in the run list and in the Tasks section', async () => {
    // The plan is A, B (needs A), C; the page keeps plan order inside a group however the tasks arrive.
    const parent = { ...runSummary(), key: 'e-1', name: 'Epic parent', taskCounts: { merged: 1, running: 2 } };
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
    const second = subtask('B', 1, 'running', 'running');
    const third = subtask('C', 2, 'running', 'running');
    const titles = () => screen.getAllByText(/^Task [ABC]$/).map((node) => node.textContent);
    renderRunList([parent, merged, second, third]);
    await userEvent
      .setup({ delay: null })
      .click(screen.getByRole('button', { name: 'Expand subtasks of Epic parent' }));
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: /^✓ 1 merged/ }));
    const inList = titles();
    cleanup();

    const planned = (run: typeof merged, depends: string[] = []) => ({
      id: run.taskId,
      index: run.task.index,
      title: run.name,
      files: [],
      proof: '',
      depends,
      status: run.task.status,
    });
    render(<TaskLayers tasks={[planned(third), planned(second, ['A']), planned(merged)]} onSkip={vi.fn()} />);
    await openSettled();

    expect(inList).toEqual(['Task B', 'Task C', 'Task A']);
    expect(titles()).toEqual(inList);
  });

  it('gives the same task order when a task waits for a person, and none to one that waits for a limit', () => {
    const parent = { ...runSummary(), key: 'e-1', name: 'Epic parent', taskCounts: { running: 3 } };
    const subtask = (id: string, index: number, state: RunState, stateReason: RunSummary['stateReason'] = null) => ({
      ...runSummary(),
      key: `e-1-${id}`,
      name: `Task ${id}`,
      parentKey: 'e-1',
      taskId: id,
      state,
      stateReason,
      task: { index, status: 'running' as SubtaskStatus },
    });
    const subtasks = [
      subtask('A', 0, 'running'),
      subtask('B', 1, 'waiting', { code: 'RUNTIME_LIMIT', message: 'Usage limit' }),
      subtask('C', 2, 'waiting', { code: 'NEEDS_ANSWERS', message: 'Questions are open' }),
    ];
    const titles = () => screen.getAllByText(/^Task [ABC]$/).map((node) => node.textContent);
    renderRunList([parent, ...subtasks]);
    const inList = titles();
    cleanup();

    const planned = subtasks.map((run) => ({
      id: run.taskId,
      index: run.task.index,
      title: run.name,
      files: [],
      proof: '',
      depends: [],
      status: run.task.status,
      run: {
        key: run.key,
        state: run.state,
        stateReason: run.stateReason,
        currentStep: 'implement',
        usd: 0,
        durationMs: 0,
      },
    }));
    render(<TaskLayers tasks={planned} onSkip={vi.fn()} />);

    expect(inList).toEqual(['Task C', 'Task A', 'Task B']);
    expect(titles()).toEqual(inList);
  });
});
