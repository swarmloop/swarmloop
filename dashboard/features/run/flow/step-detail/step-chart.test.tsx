import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { visitView } from '../../../../test/fixtures';
import { StepChart } from './step-chart';

describe('StepChart', () => {
  it('shows nothing when there is no visit', () => {
    const { container } = render(<StepChart visit={undefined} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing for a finished visit without samples', () => {
    render(<StepChart visit={visitView({ status: 'done', samples: [] })} />);

    expect(screen.getByText('This step started no container.')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'CPU and memory' })).not.toBeInTheDocument();
  });

  it('does not count the sample of the server process as a container', () => {
    render(
      <StepChart
        visit={visitView({
          status: 'done',
          samples: [{ at: '2026-01-01T00:00:00.000Z', cpu: 0, memory: 100, source: 'server' }],
        })}
      />,
    );

    expect(screen.getByText('This step started no container.')).toBeInTheDocument();
  });

  it('draws one line for each source and the step total', () => {
    const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`;
    render(
      <StepChart
        visit={visitView({
          status: 'done',
          samples: [
            { at: at(0), cpu: 10, memory: 100, source: 'setup' },
            { at: at(1), cpu: 20, memory: 200, source: '0' },
            { at: at(2), cpu: 30, memory: 300, source: '1' },
            { at: at(3), cpu: 40, memory: 400, source: '0' },
          ],
        })}
      />,
    );

    expect(screen.getByRole('img', { name: 'CPU and memory' })).toBeInTheDocument();
    for (const label of ['setup', 'command 0', 'command 1', 'total']) {
      expect(screen.getByText(new RegExp(`^${label}`))).toBeInTheDocument();
    }
    // The total at the last sample is the latest value of every source: 10 + 40 + 30.
    expect(screen.getByText(/^total 80%/)).toBeInTheDocument();
  });

  it('shows the chart while the visit runs', () => {
    render(<StepChart visit={visitView({ status: 'running' })} />);

    expect(screen.getByRole('img', { name: 'CPU and memory' })).toBeInTheDocument();
  });

  it('shows the chart when the visit has samples', () => {
    render(
      <StepChart
        visit={visitView({
          status: 'done',
          samples: [{ at: '2026-01-01T00:00:00.000Z', cpu: 10, memory: 100, source: 'agent' }],
        })}
      />,
    );

    expect(screen.getByRole('img', { name: 'CPU and memory' })).toBeInTheDocument();
  });
});
