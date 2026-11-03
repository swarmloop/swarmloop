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

    await user.type(screen.getByRole('textbox', { name: 'Filter by key' }), 'r');

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
});
