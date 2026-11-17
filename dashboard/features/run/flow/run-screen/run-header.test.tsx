import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RUN_STATES } from '@contract/run-state';
import type { StateReason } from '@contract/run-state';
import { flowView, runSummary } from '../../../../test/fixtures';
import { runWord } from '../../run-word';
import { RunHeader } from './run-header';

function headerProps(status = 'done', overrides: Partial<ComponentProps<typeof RunHeader>> = {}) {
  return {
    flow: flowView({ status }),
    openMs: 0,
    rebasing: false,
    stopping: false,
    rebaseError: null,
    onRebase: vi.fn(),
    onStop: vi.fn(),
    onOpenRequirements: vi.fn(),
    ...overrides,
  };
}

function header(status: string, overrides: Partial<ComponentProps<typeof RunHeader>> = {}) {
  const props = headerProps(status, overrides);
  render(<RunHeader {...props} />);
  return props;
}

describe('RunHeader', () => {
  it.each(['failed', 'done', 'waiting'])('offers Rebase when the run is %s', async (status) => {
    const user = userEvent.setup({ delay: null });
    const props = header(status);

    await user.click(screen.getByRole('button', { name: 'Rebase' }));

    expect(props.onRebase).toHaveBeenCalledWith(expect.objectContaining({ type: 'click' }));
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('shows the state word of the run in place of the raw status', () => {
    const { unmount } = render(<RunHeader {...headerProps()} flow={flowView({ status: 'done', state: 'done' })} />);
    expect(screen.getByText('Ready to merge', { selector: 'p' })).toBeInTheDocument();
    unmount();
    const closed = { closed: { repo: 'acme/demo', by: null, at: '2026-05-02T08:00:00.000Z' } };
    render(<RunHeader {...headerProps()} flow={flowView({ status: 'done', state: 'done', merge: closed })} />);
    expect(screen.getByText('Closed', { selector: 'p' })).toBeInTheDocument();
  });

  it('shows Queued to merge into the epic, not Ready to merge, on a done subtask page', () => {
    header('done', {
      flow: flowView({ status: 'done', state: 'done', parentKey: 'run-0', mergeWait: 'waiting for a rebase' }),
    });

    expect(screen.getByText('Queued to merge into the epic', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByLabelText('Queued to merge into the epic: waiting for a rebase')).toBeInTheDocument();
    expect(screen.queryByText('Ready to merge')).not.toBeInTheDocument();
  });

  const reasons: (StateReason | null)[] = [
    null,
    {
      code: 'RUNTIME_LIMIT',
      message: 'limit',
      limit: { runtime: 'claude', resetsAt: '2026-11-08T21:50:00.000Z', resumesAt: '2026-11-08T21:51:00.000Z' },
    },
    { code: 'HOST_UNAVAILABLE', message: 'host', retryAt: '2026-11-08T21:50:00.000Z' },
    { code: 'AGENT_PLACE', message: 'place' },
    { code: 'CHECK_FAILED', message: 'checks' },
  ];
  it.each(RUN_STATES.flatMap((state) => reasons.map((reason) => [state, reason] as const)))(
    'shows the same state word as the list for %s with %j and never the bare word waiting',
    (state, reason) => {
      const flow = flowView({ state, stateReason: reason });
      render(<RunHeader {...headerProps('running', { flow })} />);

      const word = runWord({ ...runSummary(), state, stateReason: reason }).word;
      expect(screen.getByText(word, { selector: 'p' })).toBeInTheDocument();
      expect(screen.queryByText(/^waiting$/i)).not.toBeInTheDocument();
    },
  );

  it('links to the merge request of each repository with its state, and shows no link without one', () => {
    const mergeRequests = [
      { repo: 'acme/app', url: 'https://github.com/acme/app/pull/7', state: 'open' as const },
      { repo: 'acme/lib', url: 'https://gitlab.com/acme/lib/-/merge_requests/3', state: 'merged' as const },
    ];
    const { unmount } = render(<RunHeader {...headerProps('running', { flow: flowView({ mergeRequests }) })} />);
    const github = screen.getByRole('link', { name: 'acme/app · open' });
    expect(github).toHaveAttribute('href', 'https://github.com/acme/app/pull/7');
    expect(github).toHaveAttribute('rel', 'noreferrer');
    expect(screen.getByRole('link', { name: 'acme/lib · merged' })).toHaveAttribute(
      'href',
      'https://gitlab.com/acme/lib/-/merge_requests/3',
    );
    unmount();
    header('running');
    expect(screen.queryByRole('link', { name: /·/ })).not.toBeInTheDocument();
  });

  it('opens the requirements step from the title', async () => {
    const user = userEvent.setup({ delay: null });
    const props = header('running', { flow: flowView({ title: 'Fix the login' }) });

    await user.click(screen.getByRole('button', { name: 'Fix the login' }));

    expect(props.onOpenRequirements).toHaveBeenCalledOnce();
  });

  it('shows time, cost and tokens only, with no percent and no memory value', () => {
    const flow = flowView({ metrics: { ...flowView().metrics, cpuPeak: 679, memPeak: 4107.3 * 1024 * 1024 } });
    const { container } = render(<RunHeader {...headerProps('running', { flow })} />);

    expect(container).not.toHaveTextContent('%');
    expect(container).not.toHaveTextContent(/MB|cpu|mem/);
    expect(container).toHaveTextContent('tok');
  });

  it('shows an epic as two figures whose tooltips say what they add up', async () => {
    const user = userEvent.setup({ delay: null });
    const tasks = Array.from({ length: 12 }, (_, index) => ({
      id: `t${index}`,
      index,
      title: `Task ${index}`,
      files: [],
      proof: 'passes',
      depends: [],
      status: 'merged' as const,
    }));
    const base = flowView();
    const flow = flowView({
      tasks,
      epic: { usd: 33.52, durationMs: 4 * 3600000 + 47 * 60000 },
      metrics: { ...base.metrics, usd: 11.12 },
    });
    const { container } = render(<RunHeader {...headerProps('running', { flow })} />);

    expect(container).toHaveTextContent('$33.52');
    expect(container).toHaveTextContent('4h 47m');
    expect(container).not.toHaveTextContent(/total|this run/);
    await user.hover(screen.getByText('$33.52'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('epic $11.12 + 12 tasks $22.40');
    await user.hover(screen.getByText('4h 47m'));
    expect(await screen.findByText('since the epic started')).toBeInTheDocument();
  });

  it('says when the workspace was removed and stays quiet otherwise', () => {
    header('done', { flow: flowView({ status: 'done', workspace: 'removed' }) });

    expect(screen.getByText('workspace removed')).toBeInTheDocument();
  });

  it('shows who started the run only when it is known', () => {
    const { unmount } = render(
      <RunHeader {...headerProps()} flow={flowView({ status: 'done', startedBy: 'octocat' })} />,
    );
    expect(screen.getByText('Started by octocat')).toBeInTheDocument();
    unmount();
    header('done');
    expect(screen.queryByText(/Started by/)).not.toBeInTheDocument();
  });

  it('does not mention the workspace of a run that still has it', () => {
    header('done');

    expect(screen.queryByText('workspace removed')).not.toBeInTheDocument();
  });

  it('offers Stop only while the run is running', async () => {
    const user = userEvent.setup({ delay: null });
    const props = header('running');

    expect(screen.queryByRole('button', { name: 'Rebase' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(props.onStop).toHaveBeenCalledWith(expect.objectContaining({ type: 'click' }));
  });

  it('hides Stop once the run has failed', () => {
    header('failed');

    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('links All history to the run history page', () => {
    header('running');

    expect(screen.getByRole('link', { name: 'All history' })).toHaveAttribute('href', '/runs/run-1/history');
  });

  it('cuts a very long title with an ellipsis and keeps the full text in a tooltip', async () => {
    const user = userEvent.setup({ delay: null });
    const name = 'long title '.repeat(30).slice(0, 300);
    header('done', { flow: flowView({ status: 'done', title: name }) });

    const title = screen.getByRole('heading', { name });
    expect(title).toHaveStyle({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    expect(title.parentElement?.parentElement).toHaveStyle({ minWidth: '0' });
    await user.hover(title);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(name);
  });
});
