import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { flowView } from '../../../test/fixtures';
import { RunHeader } from './run-screen/run-header';
import { WaitingPanel } from './waiting-panel';

vi.mock('../../../lib/endpoints', () => ({ sendAnswers: vi.fn(), resumeRun: vi.fn() }));

function header(flow: ReturnType<typeof flowView>) {
  render(
    <RunHeader
      flow={flow}
      openMs={0}
      rebasing={false}
      stopping={false}
      rebaseError={null}
      onRebase={vi.fn()}
      onStop={vi.fn()}
    />,
  );
}

describe('buttons follow the actions of the server', () => {
  it('shows Rebase and Stop from actions, not from the status', () => {
    header(flowView({ status: 'running', actions: ['rebase', 'stop'] }));

    expect(screen.getByRole('button', { name: 'Rebase' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('hides Rebase and Stop when actions leave them out', () => {
    header(flowView({ status: 'failed', actions: ['replay'] }));

    expect(screen.queryByRole('button', { name: 'Rebase' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('offers Resume on a block whose reason allows it', () => {
    const flow = flowView({
      status: 'blocked',
      resume: 'ready',
      state: 'blocked',
      stateReason: { code: 'CHECK_FAILED', message: 'a required check failed again' },
    });
    render(<WaitingPanel flow={flow} onChange={vi.fn()} />);

    expect(flow.actions).toEqual(['resume', 'replay']);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
  });

  it('offers no Resume on a block whose reason does not allow it', () => {
    const flow = flowView({
      status: 'blocked',
      resume: 'blocked',
      state: 'blocked',
      stateReason: { code: 'BLOCKED', message: 'blocked' },
    });
    render(<WaitingPanel flow={flow} onChange={vi.fn()} />);

    expect(flow.actions).toEqual(['replay']);
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

  it('offers Submit only when the answer action is allowed', () => {
    const items = [{ kind: 'question' as const, id: 'q1', label: 'Which database?', answer: '' }];
    render(<WaitingPanel flow={flowView({ status: 'waiting', resume: 'need-answers', items })} onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });
});
