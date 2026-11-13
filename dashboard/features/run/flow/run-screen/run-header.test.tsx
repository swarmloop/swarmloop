import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { flowView } from '../../../../test/fixtures';
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
    const user = userEvent.setup();
    const props = header(status);

    await user.click(screen.getByRole('button', { name: 'Rebase' }));

    expect(props.onRebase).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('shows Ready to merge, Merged with who and when, or Closed on a done run', () => {
    const { unmount } = render(<RunHeader {...headerProps()} />);
    expect(screen.getByText('Ready to merge')).toBeInTheDocument();
    unmount();
    const merge = {
      merged: { 'acme/demo': { sha: 'abcdef123', by: 'ada', at: '2026-05-01T10:00:00.000Z', url: null } },
    };
    const merged = render(<RunHeader {...headerProps()} flow={flowView({ status: 'done', merge })} />);
    expect(screen.getByText('Merged')).toBeInTheDocument();
    expect(screen.getByText(/by ada/)).toBeInTheDocument();
    merged.unmount();
    const closed = { closed: { repo: 'acme/demo', by: null, at: '2026-05-02T08:00:00.000Z' } };
    render(<RunHeader {...headerProps()} flow={flowView({ status: 'done', merge: closed })} />);
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });

  it('shows Queued to merge into the epic, not Ready to merge, on a done subtask page', () => {
    header('done', { flow: flowView({ status: 'done', parentKey: 'run-0', mergeWait: 'waiting for a rebase' }) });

    expect(screen.getByText('Queued to merge into the epic')).toBeInTheDocument();
    expect(screen.getByText('waiting for a rebase')).toBeInTheDocument();
    expect(screen.queryByText('Ready to merge')).not.toBeInTheDocument();
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

  it('cuts a very long title with an ellipsis and keeps the full text in a tooltip', async () => {
    const user = userEvent.setup();
    const name = 'long title '.repeat(30).slice(0, 300);
    header('done', { flow: flowView({ status: 'done', name }) });

    const title = screen.getByRole('heading', { name });
    expect(title).toHaveStyle({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    expect(title.parentElement).toHaveStyle({ minWidth: '0' });
    await user.hover(title);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(name);
  });
});
