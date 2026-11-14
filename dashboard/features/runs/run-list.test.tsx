import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { runSummary } from '../../test/fixtures';
import { RunList } from './run-list';
import { epicOfThree, listRun, renderList, STATE_RUNS, TODAY, YESTERDAY } from './run-list.spec-helpers';

const NOT_TITLE = { ignore: 'script, style, title' };

function list(overrides: Partial<ComponentProps<typeof RunList>> = {}) {
  const run = runSummary();
  const props = {
    query: '',
    onQuery: vi.fn(),
    runs: [run],
    visible: [run],
    selected: '',
    now: 0,
    error: null,
    onOpen: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  render(<RunList {...props} />);
  return props;
}

describe('RunList', () => {
  it('reports the filter text through onQuery', async () => {
    const user = userEvent.setup();
    const props = list();

    await user.type(screen.getByRole('textbox'), 'r');

    expect(props.onQuery).toHaveBeenCalledWith('r');
  });

  it('labels a done run Ready to merge, Merged with who, when and the commit, or Closed', () => {
    const done = { ...runSummary(), status: 'done', currentStep: 'done', state: 'done' as const };
    const merged = {
      ...done,
      key: 'run-2',
      name: 'Merged run',
      state: 'merged' as const,
      merge: {
        merged: {
          'acme/demo': {
            sha: 'abcdef123456',
            by: 'ada',
            at: '2026-05-01T10:00:00.000Z',
            url: 'https://github.com/acme/demo/commit/abcdef123456',
          },
        },
      },
    };
    const closed = {
      ...done,
      key: 'run-3',
      name: 'Closed run',
      state: 'closed' as const,
      merge: { closed: { repo: 'acme/demo', by: 'grace', at: '2026-05-02T08:00:00.000Z' } },
    };
    const open = { ...done, key: 'run-4', name: 'Open run' };
    list({ runs: [merged, closed, open], visible: [merged, closed, open] });

    expect(screen.getByText('Ready to merge', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Merged', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Closed', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Merged by ada/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Closed by grace/)).toBeInTheDocument();
    expect(screen.queryByText(/by ada|by grace/, NOT_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByText(/abcdef1/, NOT_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('labels a green subtask Queued to merge into the epic with its wait reason, never Ready to merge', () => {
    const queued = {
      ...runSummary(),
      status: 'done',
      currentStep: 'done',
      state: 'done' as const,
      parentKey: 'run-0',
      taskId: 'a',
      mergeWait: 'waiting for b, which is blocked',
    };
    list({ runs: [queued], visible: [queued] });

    expect(screen.getByText('Queued to merge into the epic', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByLabelText('waiting for b, which is blocked')).toBeInTheDocument();
    expect(screen.queryByText('waiting for b, which is blocked', NOT_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByText('Ready to merge')).not.toBeInTheDocument();
  });

  it('labels a merged subtask Merged', async () => {
    const user = userEvent.setup();
    const parent = { ...runSummary(), key: 'run-0', name: 'Parent run' };
    const merged = {
      ...runSummary(),
      status: 'done',
      state: 'merged' as const,
      parentKey: 'run-0',
      merge: { merged: { 'acme/demo': { sha: 'abcdef123', by: null, at: '2026-05-01T10:00:00.000Z', url: null } } },
    };
    list({ runs: [parent, merged], visible: [parent, merged] });

    await user.click(screen.getByRole('button', { name: 'Expand subtasks of Parent run' }));
    await user.click(screen.getByRole('button', { name: /^✓ 1 merged/ }));

    expect(screen.getByRole('img', { name: /^Merged/ })).toBeInTheDocument();
    expect(screen.queryByText('Queued to merge into the epic')).not.toBeInTheDocument();
  });

  it('shows no merge label on a run that is not done', () => {
    list();

    expect(screen.queryByText('Ready to merge')).not.toBeInTheDocument();
  });

  it('says No runs yet. when there are no runs', () => {
    list({ runs: [], visible: [] });

    expect(screen.getByText('No runs yet.')).toBeInTheDocument();
  });

  it('says No key matches. when the filter matches nothing', () => {
    list({ query: 'zzz', visible: [] });

    expect(screen.getByText('No key matches.')).toBeInTheDocument();
  });

  it('opens a run by its key when its row is clicked', async () => {
    const user = userEvent.setup();
    const props = list();

    await user.click(screen.getByText('Run one'));

    expect(props.onOpen).toHaveBeenCalledWith('run-1');
  });

  it('removes a run from its remove icon without opening it', async () => {
    const user = userEvent.setup();
    const props = list();

    fireEvent.mouseEnter(screen.getByText('Run one'));
    await user.click(screen.getByRole('button', { name: 'Remove Run one' }));

    expect(props.onRemove).toHaveBeenCalledWith(runSummary());
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  describe('subtasks', () => {
    const parent = { ...runSummary(), key: 'p-1', name: 'Parent run', status: 'running', usd: 2 };
    const child = {
      ...runSummary(),
      key: 'p-1-t1',
      name: 'Child one',
      status: 'waiting',
      usd: 0.5,
      parentKey: 'p-1',
      taskId: 't1',
    };

    it('lists a subtask under its parent, indented, with its own cost', async () => {
      const user = userEvent.setup();
      list({ runs: [parent, child], visible: [parent, child] });

      await user.click(screen.getByRole('button', { name: 'Expand subtasks of Parent run' }));

      const row = (name: string) => screen.getByText(name).closest('li');
      expect(row('Child one')).toHaveTextContent('$0.50');
      expect(row('Parent run')).toHaveTextContent('$2.00');
      expect(row('Parent run')).not.toHaveTextContent('$2.50');
    });

    it('marks a waiting subtask', () => {
      const waiting = { ...child, state: 'waiting' as const };
      list({ runs: [parent, waiting], visible: [parent, waiting] });

      expect(screen.getByRole('img', { name: /^Waiting for you/ })).toBeInTheDocument();
      expect(screen.queryByText('waiting')).not.toBeInTheDocument();
    });

    it('expands the subtasks while the parent is not done and collapses them once it is', () => {
      const done = { ...parent, status: 'done' };
      list({ runs: [done, child], visible: [done, child] });

      expect(screen.queryByText('Child one')).not.toBeInTheDocument();
    });

    it('toggles the subtasks from the arrow, over the default', async () => {
      const user = userEvent.setup();
      list({ runs: [parent, child], visible: [parent, child] });
      expect(screen.queryByText('Child one')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Expand subtasks of Parent run' }));
      expect(screen.getByText('Child one')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Collapse subtasks of Parent run' }));
      expect(screen.queryByText('Child one')).not.toBeInTheDocument();
    });

    it('opens a collapsed done parent from the arrow', async () => {
      const user = userEvent.setup();
      const done = { ...parent, status: 'done' };
      list({ runs: [done, child], visible: [done, child] });

      await user.click(screen.getByRole('button', { name: 'Expand subtasks of Parent run' }));

      expect(screen.getByText('Child one')).toBeInTheDocument();
    });

    it('shows a subtask whose parent is not in the list as a top-level run', () => {
      list({ runs: [child], visible: [child] });

      expect(screen.getByText('Child one')).toBeInTheDocument();
      expect(screen.getByText('Working', { selector: 'span' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /subtasks of/ })).not.toBeInTheDocument();
    });
  });

  describe('colors', () => {
    const color = (element: HTMLElement) => getComputedStyle(element).color;
    const icon = (word: RegExp) => screen.getByRole('img', { name: word });

    it('gives a parent waiting for its subtasks and a working subtask the working color, with no color on implement', () => {
      const [, , , , subtasks] = STATE_RUNS;
      const working = listRun({ key: 'w-1', name: 'Working subtask', parentKey: 'gone', state: 'running' });
      renderList([subtasks.run, working]);

      expect(color(icon(/^Waiting for subtasks/))).toBe(color(icon(/^Working/)));
      const steps = screen.getAllByText(/implement/, { selector: 'div' });
      expect(steps).toHaveLength(2);
      for (const step of steps) {
        expect(color(step)).not.toBe(color(icon(/^Working/)));
      }
    });

    it('uses the warning color only for a run waiting for an answer', () => {
      renderList(STATE_RUNS.map(({ run }) => run));

      const warning = color(icon(/^Waiting for you/));
      const sharing = STATE_RUNS.filter(({ word }) => color(icon(new RegExp(`^${word}`))) === warning);
      expect(sharing.map(({ word }) => word)).toEqual(['Waiting for you']);
    });
  });

  describe('every state', () => {
    const WORDS =
      /^(Working|Waiting for you|Paused until|Retrying at|Waiting for subtasks|Queued to merge into the epic|Blocked|Failed|Stopped|Ready to merge|Merged|Closed)/;

    it.each(STATE_RUNS)('shows $word once, with no commit or login outside a tooltip', ({ word, run }) => {
      renderList([run]);

      const words = screen.getAllByText(WORDS, { selector: 'span' });
      expect(words).toHaveLength(1);
      expect(words[0]).toHaveTextContent(new RegExp(`^${word}`));
      expect(screen.queryByText('waiting')).not.toBeInTheDocument();
      expect(screen.queryByText(/abcdef|by ada|by grace/, NOT_TITLE)).not.toBeInTheDocument();
    });

    it('writes the line 2 of a merged run as the state, time and cost', () => {
      const merged = STATE_RUNS.find(({ word }) => word === 'Merged')?.run ?? runSummary();
      renderList([merged]);

      expect(screen.getByText('Merged', { selector: 'span' }).parentElement).toHaveTextContent(
        /^Merged · 56m 0s · \$4\.06$/,
      );
    });

    it('keeps the delete out of the accessible tree until the row is hovered or focused', async () => {
      const user = userEvent.setup();
      renderList([STATE_RUNS[0].run]);
      expect(screen.queryByRole('button', { name: 'Remove Working run' })).not.toBeInTheDocument();

      await user.hover(screen.getByText('Working run'));
      expect(screen.getByRole('button', { name: 'Remove Working run' })).toBeInTheDocument();

      await user.unhover(screen.getByText('Working run'));
      expect(screen.queryByRole('button', { name: 'Remove Working run' })).not.toBeInTheDocument();

      await user.tab();
      await user.tab();
      expect(screen.getByText('Working run').closest('[data-nav]')).toHaveFocus();
      expect(screen.getByRole('button', { name: 'Remove Working run' })).toBeInTheDocument();
      await user.tab();
      expect(screen.getByRole('button', { name: 'Remove Working run' })).toHaveFocus();
    });

    it('offers a ⋯ menu with Remove where there is no hover', async () => {
      const user = userEvent.setup();
      const touch = vi.spyOn(window, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            matches: query === '(hover: none)',
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          }) as unknown as MediaQueryList,
      );
      try {
        const props = renderList([STATE_RUNS[0].run]);

        await user.click(screen.getByRole('button', { name: 'More actions for Working run' }));
        await user.keyboard('{ArrowDown}');
        expect(screen.getByRole('menuitem', { name: 'Remove' })).toHaveFocus();
        await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

        expect(props.onRemove).toHaveBeenCalledWith(STATE_RUNS[0].run);
        expect(props.onOpen).not.toHaveBeenCalled();
      } finally {
        touch.mockRestore();
      }
    });

    it('groups the rows under Today and Yesterday, keeping the incoming order in a day', () => {
      const older = listRun({ key: 'o-1', name: 'Older run', updatedAt: YESTERDAY });
      const first = listRun({ key: 't-1', name: 'First today', updatedAt: TODAY });
      const second = listRun({ key: 't-2', name: 'Second today', updatedAt: TODAY });
      renderList([older, first, second]);

      const headers = screen.getAllByText(/^(Today|Yesterday)$/).map((node) => node.textContent);
      expect(headers).toEqual(['Today', 'Yesterday']);
      const today = within(screen.getByRole('region', { name: 'Today' }));
      expect(today.getAllByText(/ today$/).map((node) => node.textContent)).toEqual(['First today', 'Second today']);
      expect(within(screen.getByRole('region', { name: 'Yesterday' })).getByText('Older run')).toBeInTheDocument();
    });

    it('moves focus with the arrow keys across rows and opens the focused one with Enter', async () => {
      const user = userEvent.setup();
      const { parent, running, blocked, merged } = epicOfThree();
      const other = listRun({ key: 'x-1', name: 'Other run', updatedAt: YESTERDAY });
      const props = renderList([parent, blocked, running, merged, other]);

      await user.click(screen.getByRole('button', { name: 'Collapse subtasks of Epic parent' }));
      await user.click(screen.getByRole('button', { name: 'Expand subtasks of Epic parent' }));
      screen.getByText('Epic parent').closest<HTMLElement>('[data-nav]')?.focus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByText('Task C').closest('[data-nav]')).toHaveFocus();
      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(screen.getByRole('button', { name: /^✓ 1 merged/ })).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByText('Other run').closest('[data-nav]')).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(props.onOpen).toHaveBeenCalledWith('x-1');
      await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
      expect(screen.getByText('Task C').closest('[data-nav]')).toHaveFocus();
    });
  });

  describe('an epic of three tasks', () => {
    const { parent, merged, running, blocked } = epicOfThree();
    const epic = [parent, blocked, merged, running];
    const group = () => within(screen.getByRole('list', { name: 'Tasks of Epic parent' }));

    it('shows the epic total and the task summary, with one bar segment per group', () => {
      renderList(epic);

      const line = screen.getByText('Waiting for subtasks', { selector: 'span' }).parentElement;
      expect(line).toHaveTextContent('$14.88');
      expect(line).toHaveTextContent('3 tasks · 1 merged · 1 blocked');
      expect(screen.getAllByTestId('progress-segment')).toHaveLength(3);
    });

    it('opens by itself for a blocked task and lists the open tasks in plan order, one line each', () => {
      renderList(epic);

      expect(screen.getByRole('button', { name: 'Collapse subtasks of Epic parent' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      expect(
        group()
          .getAllByText(/^(Task [ABC]|✓ 1 merged)$/)
          .map((node) => node.textContent),
      ).toEqual(['Task C', 'Task B', '✓ 1 merged']);
      expect(group().getAllByRole('listitem')).toHaveLength(3);
      expect(group().getByText('$0.50')).toBeInTheDocument();
      expect(group().queryByText(/Nov|\d:\d\d|abcdef/)).not.toBeInTheDocument();
    });

    it('shows the delete of a task only on hover', async () => {
      const user = userEvent.setup();
      renderList(epic);
      expect(screen.queryByRole('button', { name: 'Remove Task C' })).not.toBeInTheDocument();

      await user.hover(screen.getByText('Task C'));

      expect(screen.getByRole('button', { name: 'Remove Task C' })).toBeInTheDocument();
    });

    it('does not mute a blocked task', () => {
      renderList(epic);

      const color = (name: string) => getComputedStyle(screen.getByText(name)).color;
      expect(color('Task C')).toBe(getComputedStyle(group().getByRole('img', { name: /^Blocked/ })).color);
      expect(color('Task B')).not.toBe(color('Task C'));
    });

    it('opens the merged tasks from the ✓ line', async () => {
      const user = userEvent.setup();
      renderList(epic);
      expect(screen.queryByText('Task A')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '✓ 1 merged' }));

      expect(screen.getByText('Task A')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '✓ 1 merged' })).not.toBeInTheDocument();
    });

    it('never styles an open parent as selected, and gives a selected task the accent', async () => {
      const user = userEvent.setup();
      renderList(epic, { selected: 'e-1' });
      const row = () => screen.getByText('Epic parent').closest('[data-nav]');
      expect(row()).not.toHaveClass('Mui-selected');

      await user.click(screen.getByRole('button', { name: 'Collapse subtasks of Epic parent' }));
      expect(row()).toHaveClass('Mui-selected');
    });

    it('gives a selected task the selected look', () => {
      renderList(epic, { selected: 'e-1-C' });

      expect(screen.getByText('Task C').closest('[data-nav]')).toHaveClass('Mui-selected');
      expect(screen.getByText('Task B').closest('[data-nav]')).not.toHaveClass('Mui-selected');
    });

    it('points the toggle right when closed and down when open', async () => {
      const user = userEvent.setup();
      renderList([parent, running]);

      const toggle = screen.getByRole('button', { name: 'Expand subtasks of Epic parent' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle.querySelector('[data-direction="right"]')).not.toBeNull();

      await user.click(toggle);

      expect(toggle.querySelector('[data-direction="down"]')).not.toBeNull();
    });
  });
});
