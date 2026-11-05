import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { duration } from '../../../../lib/format';
import { visitView } from '../../../../test/fixtures';
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
    logBox: createRef<HTMLDivElement>(),
    stick: { current: true },
    ...overrides,
  };
  render(<StepDocuments {...props} />);
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
});
