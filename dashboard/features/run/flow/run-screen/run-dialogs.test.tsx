import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { flowView } from '../../../../test/fixtures';
import { RunDialogs } from './run-dialogs';

function dialogs(overrides: Partial<ComponentProps<typeof RunDialogs>> = {}) {
  const props = {
    flow: flowView(),
    confirmStop: false,
    setConfirmStop: vi.fn(),
    pending: null,
    setPending: vi.fn(),
    replay: null,
    runningElsewhere: false,
    stopRun: vi.fn().mockResolvedValue(undefined),
    startReplay: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<RunDialogs {...props} />);
  return props;
}

describe('RunDialogs', () => {
  it('closes the stop confirmation on Keep running', async () => {
    const user = userEvent.setup({ delay: null });
    const props = dialogs({ confirmStop: true });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(props.setConfirmStop).toHaveBeenCalledWith(false);
    expect(props.stopRun).not.toHaveBeenCalled();
  });

  it('calls stopRun from the stop confirmation', async () => {
    const user = userEvent.setup({ delay: null });
    const props = dialogs({ confirmStop: true });
    expect(props.stopRun).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(props.stopRun).toHaveBeenCalledTimes(1);
  });

  it('starts the replay with the pending prompt and phases on Stop and start', async () => {
    const user = userEvent.setup({ delay: null });
    const props = dialogs({
      replay: 'implement',
      runningElsewhere: true,
      pending: { prompt: 'Try again', phases: ['planning'] },
    });
    expect(props.startReplay).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Stop and start' }));

    expect(props.startReplay).toHaveBeenCalledWith('implement', 'Try again', ['planning']);
  });

  it('sends a failed replay to setError', async () => {
    const user = userEvent.setup({ delay: null });
    dialogs({
      replay: 'implement',
      runningElsewhere: true,
      pending: { prompt: 'Try again', phases: ['planning'] },
      startReplay: vi.fn().mockRejectedValue(new Error('replay refused')),
    });

    await user.click(screen.getByRole('button', { name: 'Stop and start' }));

    expect(await screen.findByText('replay refused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop and start' })).toBeEnabled();
  });

  it('asks Replay from the step when no other step runs', () => {
    dialogs({ replay: 'plan', pending: { prompt: 'again', phases: ['planning'] } });

    expect(screen.getByRole('heading', { name: 'Replay from plan?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replay' })).toBeInTheDocument();
  });
});
