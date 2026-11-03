import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { flowView } from '../../../test/fixtures';
import { RunDialogs } from './run-dialogs';

function dialogs(overrides: Partial<ComponentProps<typeof RunDialogs>> = {}) {
  const props = {
    flow: flowView(),
    error: null,
    stopping: false,
    confirmStop: false,
    setConfirmStop: vi.fn(),
    pending: null,
    setPending: vi.fn(),
    replay: null,
    stopRun: vi.fn(),
    startReplay: vi.fn().mockResolvedValue(undefined),
    setError: vi.fn(),
    ...overrides,
  };
  render(<RunDialogs {...props} />);
  return props;
}

describe('RunDialogs', () => {
  it('closes the stop confirmation on Keep running', async () => {
    const user = userEvent.setup();
    const props = dialogs({ confirmStop: true });

    await user.click(screen.getByRole('button', { name: 'Keep running' }));

    expect(props.setConfirmStop).toHaveBeenCalledWith(false);
  });

  it('calls stopRun from the stop confirmation', async () => {
    const user = userEvent.setup();
    const props = dialogs({ confirmStop: true });

    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(props.stopRun).toHaveBeenCalledTimes(1);
  });

  it('starts the replay with the pending prompt and phases on Stop and start', async () => {
    const user = userEvent.setup();
    const props = dialogs({ replay: 'implement', pending: { prompt: 'Try again', phases: ['requirements'] } });

    await user.click(screen.getByRole('button', { name: 'Stop and start' }));

    expect(props.startReplay).toHaveBeenCalledWith('implement', 'Try again', ['requirements']);
  });

  it('sends a failed replay to setError', async () => {
    const user = userEvent.setup();
    const props = dialogs({
      replay: 'implement',
      pending: { prompt: 'Try again', phases: ['requirements'] },
      startReplay: vi.fn().mockRejectedValue(new Error('replay refused')),
    });

    await user.click(screen.getByRole('button', { name: 'Stop and start' }));

    await waitFor(() => expect(props.setError).toHaveBeenCalledWith('replay refused'));
  });
});
