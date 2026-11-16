import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { visitView } from '../../../../test/fixtures';
import type { CheckCommandView } from '@contract/api';
import { NO_SAMPLES_AFTER_RESTART } from '@contract/restart-wait';
import { CommandChart, StepChart } from './step-chart';

const row = (overrides: Partial<CheckCommandView>): CheckCommandView => ({
  attempt: 'att-1',
  index: 0,
  repo: 'api',
  command: 'npm test',
  name: 'unit tests',
  status: 'passed',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:05.000Z',
  exitCode: 0,
  ...overrides,
});

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

  it('draws the step total only when asked, without a line for each command', () => {
    const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`;
    const samples = [
      { at: at(0), cpu: 10, memory: 100, source: '0' },
      { at: at(1), cpu: 20, memory: 200, source: '1' },
    ];
    render(<StepChart total visit={visitView({ status: 'done', samples })} />);

    expect(screen.getByText(/^total 30%/)).toBeInTheDocument();
    expect(screen.queryByText(/command 0/)).toBeNull();
  });

  it('says no samples were taken for a visit cut by a restart', () => {
    render(<StepChart visit={visitView({ status: 'failed', killReason: 'process died', samples: [] })} />);

    expect(screen.getByText(NO_SAMPLES_AFTER_RESTART)).toBeInTheDocument();
    expect(screen.queryByText('This step started no container.')).toBeNull();
  });

  it('says no samples were taken for a live visit in the restart wait', () => {
    render(<StepChart restarted visit={visitView({ status: 'running', samples: [] })} />);

    expect(screen.getByText(NO_SAMPLES_AFTER_RESTART)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'CPU and memory' })).toBeNull();
  });
});

describe('CommandChart', () => {
  it('draws only the samples of its own command', () => {
    const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`;
    const samples = [
      { at: at(0), cpu: 10, memory: 100, source: '0' },
      { at: at(1), cpu: 55, memory: 200, source: '1' },
    ];
    render(<CommandChart command={row({ index: 1 })} visit={visitView({ status: 'done', samples })} />);

    expect(screen.getByText('CPU 55%')).toBeInTheDocument();
  });

  it('says no samples were taken for an interrupted command', () => {
    render(
      <CommandChart command={row({ status: 'interrupted' })} visit={visitView({ status: 'failed', samples: [] })} />,
    );

    expect(screen.getByText(NO_SAMPLES_AFTER_RESTART)).toBeInTheDocument();
  });

  it('draws the empty chart for a command that has not finished', () => {
    render(<CommandChart command={row({ status: 'running' })} visit={visitView({ status: 'running', samples: [] })} />);

    expect(screen.queryByText(NO_SAMPLES_AFTER_RESTART)).toBeNull();
  });
});
