import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { flowView } from '../../../test/fixtures';
import { RunHeader } from './run-header';

function header(status: string, overrides: Partial<ComponentProps<typeof RunHeader>> = {}) {
  const props = {
    flow: flowView({ status }),
    openMs: 0,
    rebasing: false,
    stopping: false,
    rebaseError: null,
    onRebase: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  };
  render(<RunHeader {...props} />);
  return props;
}

describe('RunHeader', () => {
  it.each(['failed', 'done', 'waiting'])('offers Rebase when the run is %s', async (status) => {
    const user = userEvent.setup();
    const props = header(status);

    await user.click(screen.getByRole('button', { name: 'Rebase' }));

    expect(props.onRebase).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('offers Stop only while the run is running', async () => {
    const user = userEvent.setup();
    const props = header('running');

    expect(screen.queryByRole('button', { name: 'Rebase' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(props.onStop).toHaveBeenCalledTimes(1);
  });

  it('hides Stop once the run has failed', () => {
    header('failed');

    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('links All history to the run history page', () => {
    header('running');

    expect(screen.getByRole('link', { name: 'All history' })).toHaveAttribute('href', '/runs/run-1/history');
  });
});
