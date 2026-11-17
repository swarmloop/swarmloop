import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { visitView } from '../../../../test/fixtures';
import type { CheckCommandView } from '@contract/api';
import { NO_SAMPLES_AFTER_RESTART } from '@contract/restart-wait';
import { CommandChart, StepChart, startedNoContainer } from './step-chart';

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

/** Samples one minute apart, `count` of them, memory 100 KB each step. */
const minute = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    cpu: 50 + index * 25,
    memory: (index + 1) * 100 * 1024,
    source: 'agent',
  }));

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

  it('draws no resource charts for a visit shorter than a minute', () => {
    render(<StepChart visit={visitView({ status: 'done', durationMs: 30_000, samples: minute(2) })} />);

    expect(screen.queryByText(/^Resources:/)).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows a collapsed Resources line that opens the CPU and the memory chart', async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <StepChart
        visit={visitView({
          status: 'done',
          durationMs: 180_000,
          cpuAvg: 262,
          cpuPeak: 680,
          memPeak: 4107.3 * 1024 * 1024,
          samples: minute(3),
        })}
      />,
    );

    const line = screen.getByRole('button', { name: 'Resources: 2.6 cores avg · 6.8 peak · 4 GB peak' });
    expect(line).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('img')).toBeNull();
    await user.click(line);
    expect(screen.getByRole('img', { name: 'CPU' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Memory' })).toBeInTheDocument();
  });

  it('gives each chart its own axis', async () => {
    const user = userEvent.setup({ delay: null });
    render(<StepChart visit={visitView({ status: 'done', durationMs: 180_000, samples: minute(3) })} />);

    await user.click(screen.getByRole('button', { name: /^Resources:/ }));
    expect(within(screen.getByRole('img', { name: 'CPU' })).getByText('1.0')).toBeInTheDocument();
    expect(within(screen.getByRole('img', { name: 'Memory' })).getByText('300 KB')).toBeInTheDocument();
  });

  it('draws one line for each source and the step total', async () => {
    const user = userEvent.setup({ delay: null });
    const at = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    render(
      <StepChart
        visit={visitView({
          status: 'done',
          durationMs: 240_000,
          samples: [
            { at: at(0), cpu: 10, memory: 100, source: 'setup' },
            { at: at(1), cpu: 20, memory: 200, source: '0' },
            { at: at(2), cpu: 30, memory: 300, source: '1' },
            { at: at(3), cpu: 40, memory: 400, source: '0' },
          ],
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /^Resources:/ }));
    for (const label of ['setup', 'command 0', 'command 1', 'total']) {
      // One legend entry in the CPU chart and one in the memory chart.
      expect(screen.getAllByText(new RegExp(`^${label}`))).toHaveLength(2);
    }
    // The total at the last sample is the latest value of every source: 10 + 40 + 30.
    expect(screen.getByText('total 0.8 cores')).toBeInTheDocument();
  });

  it('shows the chart while the visit runs', () => {
    render(<StepChart visit={visitView({ status: 'running', samples: minute(2) })} />);

    expect(screen.getByRole('button', { name: /^Resources:/ })).toBeInTheDocument();
  });

  it('shows the chart when the visit has samples', () => {
    render(
      <StepChart
        visit={visitView({
          status: 'done',
          durationMs: 120_000,
          samples: [{ at: '2026-01-01T00:00:00.000Z', cpu: 10, memory: 100, source: 'agent' }],
        })}
      />,
    );

    expect(screen.getByRole('button', { name: /^Resources:/ })).toBeInTheDocument();
  });

  it('draws the step total only when asked, without a line for each command', async () => {
    const user = userEvent.setup({ delay: null });
    const at = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    const samples = [
      { at: at(0), cpu: 10, memory: 100, source: '0' },
      { at: at(1), cpu: 20, memory: 200, source: '1' },
    ];
    render(<StepChart total visit={visitView({ status: 'done', durationMs: 120_000, samples })} />);

    await user.click(screen.getByRole('button', { name: /^Resources:/ }));
    expect(screen.getAllByText('total 0.3 cores')).toHaveLength(1);
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

  it('leaves the no-container sentence to the transcript when the feed is shown', () => {
    const { container } = render(<StepChart feed visit={visitView({ status: 'done', samples: [] })} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('startedNoContainer', () => {
  it('is true for a finished visit without container samples', () => {
    expect(startedNoContainer(visitView({ status: 'done', samples: [] }), false)).toBe(true);
  });

  it('is false for a running visit, a restart, a visit with samples and no visit', () => {
    expect(startedNoContainer(visitView({ status: 'running', samples: [] }), false)).toBe(false);
    expect(startedNoContainer(visitView({ status: 'failed', samples: [] }), true)).toBe(false);
    expect(startedNoContainer(visitView({ status: 'failed', killReason: 'process died', samples: [] }), false)).toBe(
      false,
    );
    expect(startedNoContainer(visitView({ status: 'done', samples: minute(1) }), false)).toBe(false);
    expect(startedNoContainer(undefined, false)).toBe(false);
  });
});
