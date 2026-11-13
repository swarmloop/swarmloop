import { render, screen, within } from '@testing-library/react';
import { createTheme } from '@mui/material/styles';
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
    ],
  },
];

describe('FlowBoard', () => {
  it('shows the phase headings', () => {
    render(<FlowBoard phases={phases} returns={[]} selected={null} onSelect={vi.fn()} />);

    expect(screen.getByText('implementation')).toBeInTheDocument();
  });

  it('shows a card that is preparing in the working style with the word preparing', () => {
    const board: FlowView['phases'] = [
      {
        phase: 'code-review',
        steps: [{ name: 'code-review-quality', status: 'preparing', current: true, attempts: 0 }],
      },
    ];
    render(<FlowBoard phases={board} returns={[]} selected={null} onSelect={vi.fn()} />);

    const card = screen.getByRole('button', { name: /quality/ });
    expect(within(card).getByText('preparing')).toBeInTheDocument();
    expect(card).toHaveAttribute('aria-current', 'step');
  });

  it('shows a returned card with the return icon, the place it went to, and neither the error nor the warning color', async () => {
    const user = userEvent.setup();
    const board: FlowView['phases'] = [
      { phase: 'checks', steps: [{ name: 'checks', status: 'returned', current: false, attempts: 1 }] },
    ];
    const returns: FlowView['returns'] = [{ counter: 'checks', count: 1, from: 'checks', to: 'implement' }];
    render(<FlowBoard phases={board} returns={returns} selected={null} onSelect={vi.fn()} />);

    const card = screen.getByRole('button', { name: /checks/ });
    expect(within(card).getByTestId('UndoIcon')).toBeInTheDocument();
    expect(within(card).getByText('1')).toHaveStyle({ backgroundColor: 'var(--chart-returns)' });
    const { palette } = createTheme();
    expect(card).not.toHaveStyle({ borderColor: palette.error.main });
    expect(within(card).getByText('1')).not.toHaveStyle({ backgroundColor: palette.warning.main });
    await user.hover(card);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('returned to implement');
  });

  it('reports the clicked step by name', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<FlowBoard phases={phases} returns={[]} selected={null} onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'implement-improve' }));

    expect(onSelect).toHaveBeenCalledWith('implement-improve');
  });

  it('marks the current step and shows its attempt count', () => {
    render(<FlowBoard phases={phases} returns={[]} selected={null} onSelect={vi.fn()} />);

    const current = screen.getByRole('button', { name: /^implement\s*2$/ });
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(within(current).getByText('2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'implement-improve' })).not.toHaveAttribute('aria-current');
  });

  it('draws the return edge from checks to implement next to the review and pipeline edges', () => {
    const board: FlowView['phases'] = [
      { phase: 'planning', steps: [{ name: 'plan', status: 'done', current: false, attempts: 1 }] },
      { phase: 'implementation', steps: [{ name: 'implement', status: 'waiting', current: true, attempts: 2 }] },
      { phase: 'checks', steps: [{ name: 'checks', status: 'waiting', current: false, attempts: 1 }] },
      { phase: 'code-review', steps: [{ name: 'code-review', status: 'idle', current: false, attempts: 0 }] },
    ];
    render(
      <FlowBoard
        phases={board}
        returns={[
          { counter: 'review', count: 1, from: 'code-review', to: 'implement' },
          { counter: 'checks', count: 2, from: 'checks', to: 'implement' },
        ]}
        selected={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('checks → implement · checks × 2')).toBeInTheDocument();
    expect(screen.getByText('code-review → implement · review × 1')).toBeInTheDocument();
    expect(screen.getByText('code review')).toBeInTheDocument();
  });
});
