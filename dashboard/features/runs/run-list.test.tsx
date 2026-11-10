import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { runSummary } from '../../test/fixtures';
import { RunList } from './run-list';

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

    it('lists a subtask under its parent, indented, with its own cost', () => {
      list({ runs: [parent, child], visible: [parent, child] });

      const row = (name: string) => screen.getByText(name).closest('li');
      expect(row('Child one')).toHaveStyle({ paddingLeft: '16px' });
      expect(row('Parent run')).toHaveStyle({ paddingLeft: '0px' });
      expect(row('Child one')).toHaveTextContent('$0.50');
      expect(row('Parent run')).toHaveTextContent('$2.00');
      expect(row('Parent run')).not.toHaveTextContent('$2.50');
    });

    it('marks a waiting subtask', () => {
      list({ runs: [parent, child], visible: [parent, child] });

      expect(screen.getByText('waiting')).toBeInTheDocument();
    });

    it('expands the subtasks while the parent is not done and collapses them once it is', () => {
      const done = { ...parent, status: 'done' };
      list({ runs: [done, child], visible: [done, child] });

      expect(screen.queryByText('Child one')).not.toBeInTheDocument();
    });

    it('toggles the subtasks from the arrow, over the default', async () => {
      const user = userEvent.setup();
      list({ runs: [parent, child], visible: [parent, child] });

      await user.click(screen.getByRole('button', { name: 'Collapse subtasks of Parent run' }));
      expect(screen.queryByText('Child one')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Expand subtasks of Parent run' }));
      expect(screen.getByText('Child one')).toBeInTheDocument();
    });

    it('opens a collapsed done parent from the arrow', async () => {
      const user = userEvent.setup();
      const done = { ...parent, status: 'done' };
      list({ runs: [done, child], visible: [done, child] });

      await user.click(screen.getByRole('button', { name: 'Expand subtasks of Parent run' }));

      expect(screen.getByText('Child one')).toBeInTheDocument();
    });
  });
});
