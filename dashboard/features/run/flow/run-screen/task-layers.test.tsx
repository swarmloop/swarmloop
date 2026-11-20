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
      visible={runs}
      part="active"
      otherMatches={0}
      total={runs.length}
      next={null}
      onLoadMore={vi.fn()}
      onPart={vi.fn()}
      selected=""
      now={0}
      loaded
      error={null}
      onRetry={vi.fn()}
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
    expect(region).toHaveTextContent('Working · code review');
    expect(region).toHaveTextContent('after t3');
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

  it('sums the subtasks in one summary line', () => {
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
    expect(region).toHaveTextContent('after r1');
    expect(region).toHaveTextContent('after r2, r3');
    expect(region).toHaveTextContent('waiting for a free slot');
    expect(region).not.toHaveTextContent('after m');
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

  it('shows a running task and a task waiting for another with the working look of the run list', () => {
    const waiting = task('t6', { status: 'waiting', waitsFor: ['Title t3'], run: undefined });
    render(<TaskLayers tasks={[tasks[2], waiting]} onSkip={vi.fn()} />);

    const region = screen.getByRole('region', { name: 'Tasks' });
    const running = within(region).getByRole('img', { name: 'Working' });
    const pending = within(region).getByRole('img', { name: 'Waiting to start' });
    expect(running).toHaveStyle({ color: getComputedStyle(pending).color });
    expect(getComputedStyle(pending).color).not.toBe('');
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

  it('shows a relaunched interruption only in the state icon of a one-line row', () => {
    const interrupted = task('t3', {
      status: 'running',
      run: {
        key: 'run-1-t3',
        state: 'running',
        currentStep: 'implement',
        usd: 0.25,
        durationMs: 5000,
        interruption: { at: '2026-11-18T13:24:00Z', relaunched: true },
      },
    });
    render(<TaskLayers tasks={[interrupted]} onSkip={vi.fn()} />);

    const row = screen.getByText('Title t3').closest('li')!;
    expect(within(row).getByRole('img', { name: /Interrupted at/ })).toBeInTheDocument();
    // The icon's own title is the one place the sentence appears; no caption repeats it.
    expect(row.textContent?.match(/Interrupted at/g)).toHaveLength(1);
    expect(row).toHaveTextContent('Working · implement');
    expect(row).toHaveTextContent('5s · $0.25');
  });

  it('says in the caption that an interruption was not started again', () => {
    const interrupted = task('t3', {
      status: 'running',
      run: {
        key: 'run-1-t3',
        state: 'running',
        currentStep: 'implement',
        usd: 0.25,
        durationMs: 5000,
        interruption: { at: '2026-11-18T13:24:00Z', relaunched: false, cause: 'stop' },
      },
    });
    render(<TaskLayers tasks={[interrupted]} onSkip={vi.fn()} />);

    const sentence = screen.getByText(/Not started again/);
    expect(sentence).toBeInTheDocument();
    // On its own line, not in the row that holds the title.
    expect(sentence.parentElement).not.toBe(screen.getByText('Title t3').parentElement);
  });

  it('says once which tasks a waiting task waits for, by id and without titles', () => {
    const waiting = task('t6', { depends: ['t3', 't1'], status: 'waiting', waitsFor: ['Title t3'], run: undefined });
    render(<TaskLayers tasks={[tasks[0], tasks[2], waiting]} onSkip={vi.fn()} />);

    const region = screen.getByRole('region', { name: 'Tasks' });
    expect(region.textContent?.match(/after t3/g)).toHaveLength(1);
    expect(region).not.toHaveTextContent('waiting for Title');
  });

  it('shows the reason of a blocked task on a second line with Skip task', () => {
    const blocked = task('t5', {
      status: 'blocked',
      run: {
        key: 'run-1-t5',
        state: 'blocked',
        currentStep: 'implement',
        usd: 1,
        durationMs: 1000,
        stateReason: { code: 'GIT_AUTH', message: 'Push was refused' },
      },
    });
    render(<TaskLayers tasks={[blocked]} onSkip={vi.fn()} />);

    const row = screen.getByText('Title t5').closest('li')!;
    expect(within(row).getByText('Push was refused')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Skip task' })).toBeInTheDocument();
  });

  it('opens the plan from the chevron at the row end', async () => {
    render(<TaskLayers tasks={[task('t3', { status: 'running' })]} onSkip={vi.fn()} />);

    const chevron = screen.getByRole('button', { name: /^Plan|^Changes/ });
    expect(chevron).toHaveAttribute('aria-expanded', 'false');
    expect(chevron).toHaveTextContent('');
    expect(chevron.querySelector('[data-direction]')).toHaveAttribute('data-direction', 'right');
    await userEvent.setup({ delay: null }).click(chevron);

    expect(chevron).toHaveAttribute('aria-expanded', 'true');
    expect(chevron.querySelector('[data-direction]')).toHaveAttribute('data-direction', 'down');
  });

  it('skips a blocked task', async () => {
    const onSkip = vi.fn().mockResolvedValue(undefined);
    render(<TaskLayers tasks={tasks} onSkip={onSkip} />);
    const user = userEvent.setup({ delay: null });

    await user.click(screen.getByRole('button', { name: 'Skip task' }));
    expect(onSkip).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Skip task' }));

    expect(onSkip).toHaveBeenCalledWith('t5');
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
    const parent = {
      ...runSummary(),
      key: 'e-1',
      name: 'Epic parent',
      title: 'Epic parent',
      taskCounts: { merged: 1, running: 2 },
    };
    const subtask = (id: string, index: number, status: SubtaskStatus, state: RunState) => ({
      ...runSummary(),
      key: `e-1-${id}`,
      name: `Task ${id}`,
      title: `Task ${id}`,
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
    const parent = {
      ...runSummary(),
      key: 'e-1',
      name: 'Epic parent',
      title: 'Epic parent',
      taskCounts: { running: 3 },
    };
    const subtask = (id: string, index: number, state: RunState, stateReason: RunSummary['stateReason'] = null) => ({
      ...runSummary(),
      key: `e-1-${id}`,
      name: `Task ${id}`,
      title: `Task ${id}`,
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

  it('marks the tasks the latest plan change added or changed', () => {
    const revision = {
      version: 2,
      reason: 'You asked for more',
      summary: 'Two tasks',
      added: ['Title t2'],
      changed: ['Title t3'],
      dropped: [],
      at: '2026-11-15T07:11:43.444Z',
    };
    render(
      <TaskLayers
        tasks={[
          task('t1', { status: 'blocked' }),
          task('t2', { status: 'blocked' }),
          task('t3', { status: 'blocked' }),
        ]}
        revision={revision}
        onSkip={vi.fn()}
      />,
    );

    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).not.toHaveTextContent('in this plan');
    expect(rows[1]).toHaveTextContent('New in this plan');
    expect(rows[2]).toHaveTextContent('Changed in this plan');
  });
});
