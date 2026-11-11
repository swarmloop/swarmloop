import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TaskLayer } from '@contract/api';
import { TaskLayers } from './task-layers';

const layers: TaskLayer[] = [
  {
    layer: 0,
    tasks: [
      {
        id: 'a',
        title: 'Add the column',
        files: ['a.ts'],
        proof: 'a.spec.ts',
        status: 'merged',
        run: { key: 'run-1-a', currentStep: 'done', usd: 1.5, durationMs: 65000 },
      },
    ],
  },
  {
    layer: 1,
    tasks: [
      {
        id: 'b',
        title: 'Send it',
        files: ['b.ts'],
        proof: 'b.spec.ts',
        status: 'running',
        run: { key: 'run-1-b', currentStep: 'implement', usd: 0.25, durationMs: 5000 },
      },
      { id: 'c', title: 'Show it', files: [], proof: 'c', status: 'blocked' },
    ],
  },
];

describe('TaskLayers', () => {
  it('shows per task its step, own cost, time and a link to its run', () => {
    render(<TaskLayers layers={layers} line="Split: 3 tasks · 1 merged · 1 running" onSkip={vi.fn()} />);

    const region = screen.getByRole('region', { name: 'Tasks' });
    expect(region).toHaveTextContent('Split: 3 tasks · 1 merged · 1 running');
    expect(region).toHaveTextContent('Layer 1');
    expect(region).toHaveTextContent('Layer 2');
    expect(region).toHaveTextContent('implement · $0.25 · 5s');
    expect(region).toHaveTextContent('done · $1.50');
    const links = within(region).getAllByRole('link', { name: 'Open run' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/runs/run-1-a', '/runs/run-1-b']);
  });

  it('skips a blocked task', async () => {
    const onSkip = vi.fn();
    render(<TaskLayers layers={layers} onSkip={onSkip} />);

    await userEvent.click(screen.getByRole('button', { name: 'Skip task' }));

    expect(onSkip).toHaveBeenCalledWith('c');
  });

  it('shows the merge queue and the decisions, and hides them when empty', () => {
    const { rerender } = render(
      <TaskLayers
        layers={layers}
        mergeQueue={[{ id: 'b', title: 'Send it' }]}
        decisions="- subtask a: use UTC"
        onSkip={vi.fn()}
      />,
    );

    expect(within(screen.getByRole('region', { name: 'Merge queue' })).getByText('Send it')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Decisions' })).toHaveTextContent('decisions:- subtask a: use UTC');

    rerender(<TaskLayers layers={layers} onSkip={vi.fn()} />);

    expect(screen.queryByRole('region', { name: 'Merge queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Decisions' })).not.toBeInTheDocument();
  });
});
