import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { flowView } from '../../../../test/fixtures';
import { RunDialogs } from './run-dialogs';

function baseProps(overrides: Partial<ComponentProps<typeof RunDialogs>> = {}): ComponentProps<typeof RunDialogs> {
  return {
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
}

function dialogs(overrides: Partial<ComponentProps<typeof RunDialogs>> = {}) {
  const props = baseProps(overrides);
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

  it('hands the pending upload ids to the replay', async () => {
    const user = userEvent.setup({ delay: null });
    const props = dialogs({
      replay: 'implement',
      runningElsewhere: true,
      pending: { prompt: 'Try again', phases: ['planning'], attachments: ['u1'] },
    });

    await user.click(screen.getByRole('button', { name: 'Stop and start' }));

    expect(props.startReplay).toHaveBeenCalledWith('implement', 'Try again', ['planning'], ['u1']);
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

  it('says in the stop confirmation which merge request stays open, and none when there is none', () => {
    const open = [{ repo: 'acme/app', url: 'https://github.com/acme/app/pull/7', state: 'open' as const }];
    const { unmount } = render(
      <RunDialogs {...baseProps({ confirmStop: true, flow: flowView({ mergeRequests: open }) })} />,
    );
    expect(screen.getByRole('dialog')).toHaveTextContent('the merge request in acme/app stays open');
    unmount();
    render(<RunDialogs {...baseProps({ confirmStop: true })} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('No merge request is open yet.');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('stays open');
  });

  it('removes the subtasks only for a split run replayed from the plan', () => {
    const tasks = [
      { id: 'a', index: 0, title: 'A', files: [], proof: 'a', depends: [], status: 'running' as const },
      { id: 'b', index: 1, title: 'B', files: [], proof: 'b', depends: [], status: 'waiting' as const },
    ];
    const pending = { prompt: 'again', phases: ['planning' as const] };
    const { unmount } = render(<RunDialogs {...baseProps({ flow: flowView({ tasks }), replay: 'plan', pending })} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('The 2 subtasks of the plan are removed');
    unmount();
    render(<RunDialogs {...baseProps({ flow: flowView({ tasks }), replay: 'implement', pending })} />);
    expect(screen.getByRole('dialog')).not.toHaveTextContent('subtasks');
    expect(screen.getByRole('dialog')).toHaveTextContent('The results of the later steps are replaced');
  });
});
