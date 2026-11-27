import { render, screen, within } from '@testing-library/react';
import { createTheme } from '@mui/material/styles';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CheckCommandView, FlowView } from '@contract/api';
import { restartWaitSentence } from '@contract/restart-wait';
import { localTime } from '../../../lib/format';
import { mediaWidth } from '../../../test/viewport';
import { statusColor } from '../../../theme/theme';
import { FlowBoard } from './flow-board';

const errorColor = createTheme().palette.error.main;
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
  it('says the restart wait in the chip note in place of running, and keeps a note that is set', () => {
    const at = '2026-01-01T10:00:00.000Z';
    const board: FlowView['phases'] = [
      {
        phase: 'implementation',
        steps: [
          { name: 'implement', status: 'waiting', current: true, attempts: 1, restartedAt: at },
          { name: 'implement-improve', status: 'waiting', current: false, attempts: 1, note: 'Waiting for a place' },
        ],
      },
    ];
    render(<FlowBoard phases={board} returns={[]} selected={null} onSelect={vi.fn()} />);

    expect(screen.getByText(restartWaitSentence(at, localTime))).toBeInTheDocument();
    expect(screen.getByText('Waiting for a place')).toBeInTheDocument();
  });

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

  it('shows a returned card with the return icon and, on hover, why it came back in words', async () => {
    const user = userEvent.setup({ delay: null });
    const board: FlowView['phases'] = [
      {
        phase: 'checks',
        steps: [
          {
            name: 'checks',
            status: 'returned',
            current: false,
            attempts: 2,
            returnNote: 'Checks sent it back: dashboard tests',
          },
        ],
      },
    ];
    const returns: FlowView['returns'] = [{ counter: 'checks', count: 2, from: 'checks', to: 'implement' }];
    render(<FlowBoard phases={board} returns={returns} selected={null} onSelect={vi.fn()} />);

    const card = screen.getByRole('button', { name: /checks/ });
    expect(within(card).getByTestId('UndoIcon')).toBeInTheDocument();
    expect(card).toHaveStyle({ borderColor: errorColor });
    await user.hover(card);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Checks sent it back: dashboard tests');
  });

  it('shows a failed card in the error color with its own icon', () => {
    const board: FlowView['phases'] = [
      { phase: 'checks', steps: [{ name: 'checks', status: 'failed', current: false, attempts: 1 }] },
    ];
    render(<FlowBoard phases={board} returns={[]} selected={null} onSelect={vi.fn()} />);

    const card = screen.getByRole('button', { name: /checks/ });
    expect(within(card).getByTestId('ErrorOutlineIcon')).toBeInTheDocument();
    expect(within(card).queryByTestId('UndoIcon')).toBeNull();
    expect(card).toHaveStyle({ borderColor: errorColor });
  });

  it('does not use the error color for a step that was not returned, and shows no count for one visit', () => {
    render(<FlowBoard phases={phases} returns={[]} selected={null} onSelect={vi.fn()} />);

    expect(screen.getByRole('button', { name: /^implement\s*×2$/ })).not.toHaveStyle({ borderColor: errorColor });
    const once: FlowView['phases'] = [
      { phase: 'implementation', steps: [{ name: 'implement', status: 'done', current: false, attempts: 1 }] },
    ];
    render(<FlowBoard phases={once} returns={[]} selected={null} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^implement$/ })).not.toHaveTextContent('1');
  });

  it('shows a muted ×3 for a step that ran three times', () => {
    const board: FlowView['phases'] = [
      { phase: 'checks', steps: [{ name: 'checks', status: 'done', current: false, attempts: 3 }] },
    ];
    render(<FlowBoard phases={board} returns={[]} selected={null} onSelect={vi.fn()} />);

    expect(screen.getByText('×3')).toHaveStyle({ fontSize: '10px' });
  });

  it('keeps the done card in its column as a marker that is not a button', () => {
    const board: FlowView['phases'] = [
      { phase: 'implementation', steps: [{ name: 'implement', status: 'done', current: false, attempts: 1 }] },
      { phase: 'finish', steps: [{ name: 'done', status: 'done', current: false, attempts: 0 }] },
    ];
    render(<FlowBoard phases={board} returns={[]} selected={null} onSelect={vi.fn()} />);

    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^done$/ })).toBeNull();
    expect(screen.getByRole('button', { name: /implement/ })).toBeInTheDocument();
  });

  it('says the run state word in the tooltip of a waiting current step', async () => {
    const user = userEvent.setup({ delay: null });
    const board: FlowView['phases'] = [
      { phase: 'implementation', steps: [{ name: 'implement', status: 'waiting', current: true, attempts: 1 }] },
    ];
    render(
      <FlowBoard
        phases={board}
        returns={[]}
        selected={null}
        onSelect={vi.fn()}
        stateReason={{ code: 'NEEDS_ANSWERS', message: 'question' }}
      />,
    );

    await user.hover(screen.getByRole('button', { name: /implement/ }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Waiting for you');
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
    expect(within(screen.getByRole('button', { name: /^implement$/ })).queryByText(/checked/)).toBeNull();
  });

  it('reports the clicked step by name', async () => {
    const user = userEvent.setup({ delay: null });
    const onSelect = vi.fn();
    render(<FlowBoard phases={phases} returns={[]} selected={null} onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'implement-improve' }));

    expect(onSelect).toHaveBeenCalledWith('implement-improve');
  });

  it('marks the current step and shows its attempt count', () => {
    render(<FlowBoard phases={phases} returns={[]} selected={null} onSelect={vi.fn()} />);

    const current = screen.getByRole('button', { name: /^implement\s*×2$/ });
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(within(current).getByText('×2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'implement-improve' })).not.toHaveAttribute('aria-current');
  });

  it('draws one quiet row per return after the work passed, and ties implement ×2 to it', async () => {
    const user = userEvent.setup({ delay: null });
    const board: FlowView['phases'] = [
      { phase: 'implementation', steps: [{ name: 'implement', status: 'done', current: false, attempts: 2 }] },
      { phase: 'checks', steps: [{ name: 'checks', status: 'done', current: false, attempts: 1 }] },
      { phase: 'code-review', steps: [{ name: 'code-review', status: 'done', current: false, attempts: 2 }] },
    ];
    const { container } = render(
      <FlowBoard
        phases={board}
        returns={[
          {
            counter: 'review',
            count: 1,
            from: 'code-review',
            to: 'implement',
            why: 'review_requirements,review_quality',
            words: 'Code review sent it back: requirements, quality',
          },
          { counter: 'checks', count: 2, from: 'checks', to: 'implement', why: 'npm test --prefix dashboard' },
        ]}
        selected={null}
        onSelect={vi.fn()}
      />,
    );

    expect(
      screen.getByText('code review → implement · once · Code review sent it back: requirements, quality'),
    ).toBeInTheDocument();
    expect(screen.getByText('checks → implement · 2 times')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/review_|npm test/);
    await user.hover(screen.getByRole('button', { name: /implement/ }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '2 visits: code review sent it back once, checks sent it back 2 times',
    );
  });

  it('keeps the last outcome and the visit count of a step that will run again, and shows the return that moved the run', () => {
    const board: FlowView['phases'] = [
      { phase: 'implementation', steps: [{ name: 'implement', status: 'running', current: true, attempts: 4 }] },
      {
        phase: 'checks',
        steps: [{ name: 'checks', status: 'again', current: false, attempts: 3, lastOutcome: 'done' }],
      },
      {
        phase: 'code-review',
        steps: [{ name: 'code-review', status: 'again', current: false, attempts: 7, lastOutcome: 'done' }],
      },
      {
        phase: 'ci',
        steps: [
          {
            name: 'pipeline',
            status: 'again',
            current: false,
            attempts: 6,
            lastOutcome: 'CI sent it back: merge conflict: automatic rebase → implement',
          },
          { name: 'merge-request', status: 'idle', current: false, attempts: 0 },
        ],
      },
    ];
    const returns: FlowView['returns'] = [
      {
        counter: 'pipeline',
        count: 3,
        from: 'pipeline',
        to: 'implement',
        words: 'CI sent it back: merge conflict: automatic rebase',
      },
    ];
    render(<FlowBoard phases={board} returns={returns} selected={null} onSelect={vi.fn()} />);

    expect(
      screen.getByText('pipeline → implement · 3 times · CI sent it back: merge conflict: automatic rebase'),
    ).toBeInTheDocument();
    const pipeline = screen.getByRole('button', { name: /pipeline/ });
    expect(within(pipeline).getByText('will run again')).toBeInTheDocument();
    expect(
      within(pipeline).getByText('CI sent it back: merge conflict: automatic rebase → implement'),
    ).toBeInTheDocument();
    expect(within(pipeline).getByText('×6')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /checks/ })).getByText('will run again')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /report/ })).getByText('will run again')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /merge-request/ })).queryByText('will run again')).toBeNull();
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

    it('reads 0/8 with the skipped part in the skipped colour, and says it waits for a free check slot', () => {
      const statuses: CheckCommandView['status'][] = [
        ...Array<CheckCommandView['status']>(4).fill('skipped'),
        ...Array<CheckCommandView['status']>(8).fill('waiting'),
      ];
      const card = draw(statuses);

      expect(within(card).getByText('0/8')).toBeInTheDocument();
      expect(within(card).getByText('waits for a free check slot')).toBeInTheDocument();
      const skipped = card.querySelector('[data-part="skipped"]');
      expect(skipped).toHaveStyle({ flexGrow: '4' });
      expect(skipped).toHaveStyle({ backgroundColor: statusColor('skipped') });
    });

    it('does not say it waits while a command runs', () => {
      const card = draw(['running', 'waiting']);

      expect(within(card).queryByText('waits for a free check slot')).toBeNull();
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

const twoPhases: FlowView['phases'] = [
  ...phases,
  { phase: 'code-review', steps: [{ name: 'code-review-quality', status: 'idle', current: false, attempts: 0 }] },
];

describe('FlowBoard at 375 px', () => {
  mediaWidth(375);

  it('puts one phase in each row, its cards in a sideways scroll that keeps their width', () => {
    render(<FlowBoard phases={twoPhases} returns={[]} selected={null} onSelect={vi.fn()} />);

    const label = screen.getByText('implementation');
    expect(label.parentElement?.parentElement).toHaveStyle({ gridTemplateColumns: 'minmax(0, 1fr)' });
    const cards = label.nextElementSibling as HTMLElement;
    expect(cards).toHaveStyle({ overflowX: 'auto', display: 'flex' });
    expect(screen.getByRole('button', { name: /implement-improve|improve/ })).toHaveStyle({
      minWidth: '160px',
      flex: 'none',
    });
  });

  it('still selects a card', async () => {
    const onSelect = vi.fn();
    render(<FlowBoard phases={twoPhases} returns={[]} selected={null} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole('button', { name: /quality/ }));

    expect(onSelect).toHaveBeenCalledWith('code-review-quality');
  });
});

describe('FlowBoard at 1280 px', () => {
  mediaWidth(1280);

  it('keeps one column for each phase', () => {
    render(<FlowBoard phases={twoPhases} returns={[]} selected={null} onSelect={vi.fn()} />);

    const label = screen.getByText('implementation');
    expect(label.parentElement?.parentElement).toHaveStyle({ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' });
    expect(label.nextElementSibling).not.toHaveStyle({ overflowX: 'auto' });
  });
});
