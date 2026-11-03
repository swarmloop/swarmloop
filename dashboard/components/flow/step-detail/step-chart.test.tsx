import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { visitView } from '../../../test/fixtures';
import { StepChart } from './step-chart';

describe('StepChart', () => {
  it('shows nothing when there is no visit', () => {
    const { container } = render(<StepChart visit={undefined} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing for a finished visit without samples', () => {
    const { container } = render(<StepChart visit={visitView({ status: 'done', samples: [] })} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the chart while the visit runs', () => {
    render(<StepChart visit={visitView({ status: 'running' })} />);

    expect(screen.getByRole('img', { name: 'CPU and memory' })).toBeInTheDocument();
  });

  it('shows the chart when the visit has samples', () => {
    render(
      <StepChart
        visit={visitView({ status: 'done', samples: [{ at: '2026-01-01T00:00:00.000Z', cpu: 10, memory: 100 }] })}
      />,
    );

    expect(screen.getByRole('img', { name: 'CPU and memory' })).toBeInTheDocument();
  });
});
