import { render, screen, within } from '@testing-library/react';
import { createTheme } from '@mui/material/styles';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CheckCommandView, FlowView } from '@contract/api';
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

  it('shows why a skipped card is skipped', () => {
    const board: FlowView['phases'] = [
      {
        phase: 'implementation',
        steps: [
          {
            name: 'implement-improve',
            status: 'skipped',
            current: false,
            attempts: 0,
            note: 'each task checked its own work',
          },
          { name: 'implement', status: 'done', current: false, attempts: 1 },
        ],
      },
    ];
    render(<FlowBoard phases={board} returns={[]} selected={null} onSelect={vi.fn()} />);

    expect(
      within(screen.getByRole('button', { name: /implement-improve/ })).getByText('each task checked its own work'),
    ).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /^implement\s*1$/ })).queryByText(/checked/)).toBeNull();
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

  describe('the checks card', () => {
    const board: FlowView['phases'] = [
      { phase: 'checks', steps: [{ name: 'checks', status: 'running', current: true, attempts: 1 }] },
    ];
    const rows = (statuses: CheckCommandView['status'][]): CheckCommandView[] =>
      statuses.map((status, index) => ({
        attempt: 'att-1',
        index,
        repo: 'api',
        command: `cmd ${index}`,
        name: null,
        status,
        startedAt: null,
        endedAt: null,
        exitCode: null,
      }));
    const draw = (statuses: CheckCommandView['status'][]) => {
      render(
        <FlowBoard phases={board} returns={[]} selected={null} onSelect={vi.fn()} checkCommands={rows(statuses)} />,
      );
      return screen.getByRole('button', { name: /checks/ });
    };

    it('shows passed/total and the bar while the checks run', () => {
      const statuses: CheckCommandView['status'][] = [
        ...Array<CheckCommandView['status']>(8).fill('passed'),
        'running',
        'running',
        'waiting',
        'waiting',
      ];
      const card = draw(statuses);

      expect(within(card).getByText('8/12')).toBeInTheDocument();
      const part = (name: string) => card.querySelector(`[data-part="${name}"]`);
      expect(part('passed')).toHaveStyle({ flexGrow: '8' });
      expect(part('running')).toHaveStyle({ flexGrow: '2' });
      expect(part('queued')).toHaveStyle({ flexGrow: '2' });
    });

    it('shows N failed in the error color with an icon after a failure', () => {
      const card = draw(['passed', 'failed', 'failed']);

      expect(within(card).getByText('2 failed')).toHaveStyle({ color: createTheme().palette.error.main });
      expect(within(card).getByTestId('ErrorOutlineIcon')).toBeInTheDocument();
      expect(within(card).queryByText(/\d+\/\d+/)).toBeNull();
    });

    it('shows 12/12 when every command passed', () => {
      const card = draw(Array<CheckCommandView['status']>(12).fill('passed'));

      expect(within(card).getByText('12/12')).toBeInTheDocument();
    });
  });
});
