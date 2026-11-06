import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { duration } from '../../../../lib/format';
import { visitView } from '../../../../test/fixtures';
import { QueryWrapper } from '../../../../test/query-wrapper';
import { stepEvent } from '../../../../test/step-events';
import { StepDocuments } from './step-documents';

const checks = [
  { name: 'requirements', decision: 'decision: ok', body: 'all met' },
  { name: 'security', decision: 'decision: return', body: 'token leaked' },
];

function documents(overrides: Partial<ComponentProps<typeof StepDocuments>> = {}) {
  const props = {
    shownChecks: checks,
    check: null,
    setCheck: vi.fn(),
    visit: visitView(),
    logs: '',
    document: '',
    runKey: 'run-1',
    step: 'implement',
    events: [],
    ...overrides,
  };
  render(<StepDocuments {...props} />, { wrapper: QueryWrapper });
  return props;
}

describe('StepDocuments', () => {
  it('selects a check by its name when its button is clicked', async () => {
    const user = userEvent.setup();
    const props = documents();

    await user.click(screen.getByRole('button', { name: 'requirements ok' }));
    expect(props.setCheck).toHaveBeenLastCalledWith('requirements');

    await user.click(screen.getByRole('button', { name: 'security return' }));
    expect(props.setCheck).toHaveBeenLastCalledWith('security');
  });

  it('shows the log text and the markdown document', () => {
    documents({ logs: 'starting the agent', document: '# Report heading' });

    expect(screen.getByText('starting the agent')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Report heading' })).toBeInTheDocument();
  });

  it('shows each exchange with its model and duration', () => {
    documents({
      visit: visitView({
        exchanges: [{ model: 'claude-opus', durationMs: 2500, request: 'list files', response: 'three files' }],
      }),
    });

    expect(screen.getByText(`claude-opus · ${duration(2500)}`)).toBeInTheDocument();
  });

  it('puts the log of a visit with no events in a card marked legacy', () => {
    documents({ logs: 'starting the agent' });

    expect(screen.getByText('legacy: details not recorded')).toBeInTheDocument();
    expect(screen.getByText('starting the agent')).toBeInTheDocument();
  });

  it('shows the transcript instead of the log and the exchanges when events were recorded', () => {
    documents({
      logs: 'starting the agent',
      events: [stepEvent(1, { kind: 'artifact.produced', artifactKind: 'diff', documentId: 4 })],
      visit: visitView({
        exchanges: [{ model: 'claude-opus', durationMs: 2500, request: 'list files', response: 'three files' }],
      }),
    });

    expect(screen.getByText(/diff · document 4/)).toBeInTheDocument();
    expect(screen.queryByText('legacy: details not recorded')).not.toBeInTheDocument();
    expect(screen.queryByText('starting the agent')).not.toBeInTheDocument();
    expect(screen.queryByText(`claude-opus · ${duration(2500)}`)).not.toBeInTheDocument();
  });

  it('shows neither the transcript nor the legacy log while the events load', () => {
    documents({ logs: 'starting the agent', events: null });

    expect(screen.queryByText('legacy: details not recorded')).not.toBeInTheDocument();
    expect(screen.queryByText('starting the agent')).not.toBeInTheDocument();
  });
});
