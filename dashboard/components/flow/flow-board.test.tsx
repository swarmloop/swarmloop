import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FlowView } from '@contract/api';
import { FlowBoard } from './flow-board';

const phases: FlowView['phases'] = [
  {
    phase: 'implementation',
    steps: [
      { name: 'implement', status: 'running', current: true, attempts: 2 },
      { name: 'implement-improve', status: 'idle', current: false, attempts: 0 },
      { name: 'verify', status: 'idle', current: false, attempts: 0 },
    ],
  },
];

describe('FlowBoard', () => {
  it('shows the phase headings', () => {
    render(<FlowBoard phases={phases} returns={[]} selected={null} onSelect={vi.fn()} />);

    expect(screen.getByText('implementation')).toBeInTheDocument();
  });

  it('reports the clicked step by name', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<FlowBoard phases={phases} returns={[]} selected={null} onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'implement-improve' }));

    expect(onSelect).toHaveBeenCalledWith('implement-improve');
  });

  it('shows verify as a step of the implementation phase', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<FlowBoard phases={phases} returns={[]} selected={null} onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'verify' }));

    expect(onSelect).toHaveBeenCalledWith('verify');
  });

  it('marks the current step and shows its attempt count', () => {
    render(<FlowBoard phases={phases} returns={[]} selected={null} onSelect={vi.fn()} />);

    const current = screen.getByRole('button', { name: /^implement\s*2$/ });
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(within(current).getByText('2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'implement-improve' })).not.toHaveAttribute('aria-current');
  });
});
