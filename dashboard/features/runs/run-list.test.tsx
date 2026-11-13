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

  it('labels a done run Ready to merge, Merged with who, when and the commit, or Closed', () => {
    const done = { ...runSummary(), status: 'done', currentStep: 'done' };
    const merged = {
      ...done,
      key: 'run-2',
      name: 'Merged run',
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
      merge: { closed: { repo: 'acme/demo', by: 'grace', at: '2026-05-02T08:00:00.000Z' } },
    };
    const open = { ...done, key: 'run-4', name: 'Open run' };
    list({ runs: [merged, closed, open], visible: [merged, closed, open] });

    expect(screen.getByText('Ready to merge')).toBeInTheDocument();
    expect(screen.getByText('Merged')).toBeInTheDocument();
    expect(screen.getByText(/by ada/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'abcdef1' })).toHaveAttribute(
      'href',
      'https://github.com/acme/demo/commit/abcdef123456',
    );
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.getByText(/by grace/)).toBeInTheDocument();
  });

  it('labels a green subtask Queued to merge into the epic with its wait reason, never Ready to merge', () => {
    const queued = {
      ...runSummary(),
      status: 'done',
      currentStep: 'done',
      parentKey: 'run-0',
      taskId: 'a',
      mergeWait: 'waiting for b, which is blocked',
    };
    list({ runs: [queued], visible: [queued] });

    expect(screen.getByText('Queued to merge into the epic')).toBeInTheDocument();
    expect(screen.getByText('waiting for b, which is blocked')).toBeInTheDocument();
    expect(screen.queryByText('Ready to merge')).not.toBeInTheDocument();
  });

  it('labels a merged subtask Merged', () => {
    const merged = {
      ...runSummary(),
      status: 'done',
      parentKey: 'run-0',
      merge: { merged: { 'acme/demo': { sha: 'abcdef123', by: null, at: '2026-05-01T10:00:00.000Z', url: null } } },
    };
    list({ runs: [merged], visible: [merged] });

    expect(screen.getByText('Merged')).toBeInTheDocument();
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
