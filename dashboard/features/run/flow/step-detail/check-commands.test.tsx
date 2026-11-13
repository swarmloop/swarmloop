import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckCommandView } from '@contract/api';
import { getRunLog } from '../../../../lib/endpoints';
import { visitView } from '../../../../test/fixtures';
import { QueryWrapper } from '../../../../test/query-wrapper';
import { LiveBridgeProvider } from '../../../shell';
import { CheckCommands } from './check-commands';

vi.mock('../../../../lib/endpoints', () => ({ getRunLog: vi.fn() }));
vi.mock('../../../../lib/live', async () => (await import('../../../../test/fake-socket')).fakeLive());

const row = (overrides: Partial<CheckCommandView>): CheckCommandView => ({
  attempt: 'att-1',
  index: 0,
  repo: 'api',
  command: 'npm run test:unit -- --coverage',
  name: 'unit tests',
  status: 'passed',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:05.000Z',
  exitCode: 0,
  ...overrides,
});

const visit = visitView({
  attemptId: 'att-1',
  status: 'running',
  samples: [
    { at: '2026-01-01T00:00:00.000Z', cpu: 10, memory: 100, source: '0' },
    { at: '2026-01-01T00:00:01.000Z', cpu: 77, memory: 200, source: '1' },
  ],
});

function list(commands: CheckCommandView[]) {
  render(
    <LiveBridgeProvider>
      <CheckCommands runKey="run-1" commands={commands} visit={visit} now={0} />
    </LiveBridgeProvider>,
    { wrapper: QueryWrapper },
  );
}

beforeEach(() => {
  vi.mocked(getRunLog).mockResolvedValue('all green\n');
});

describe('CheckCommands', () => {
  it('shows no repository column or heading for one repository', () => {
    list([row({}), row({ index: 1, name: 'lint' })]);

    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('api')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows a heading for each repository when there are two', () => {
    list([row({}), row({ index: 1, repo: 'web', name: 'build' })]);

    expect(screen.getByText('api')).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();
  });

  it('says queued for a command that has not started, and not in the warning color', () => {
    list([row({ status: 'waiting', startedAt: null, endedAt: null, exitCode: null })]);

    expect(screen.getByText('queued')).toHaveStyle({ color: createTheme().palette.text.secondary });
    expect(screen.getByText('queued')).not.toHaveStyle({ color: createTheme().palette.warning.main });
  });

  it('opens a line in place to its full command, output and own chart', async () => {
    const user = userEvent.setup();
    list([row({}), row({ index: 1, name: 'lint', command: 'npm run lint' })]);
    expect(screen.queryByText('npm run test:unit -- --coverage')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show lint' }));

    expect(screen.getByText('npm run lint')).toBeInTheDocument();
    const output = await screen.findByLabelText('Output of npm run lint');
    await waitFor(() => expect(output).toHaveTextContent('all green'));
    expect(screen.getByText('CPU 77%')).toBeInTheDocument();
  });

  it('opens a failed line by itself and shows its exit code', async () => {
    list([row({ status: 'failed', exitCode: 3 })]);

    expect(screen.getByText('exit 3')).toBeInTheDocument();
    const output = await screen.findByLabelText('Output of npm run test:unit -- --coverage');
    await waitFor(() => expect(output).toHaveTextContent('all green'));
  });

  it('says a finished visit has no commands, and says nothing while it runs', () => {
    const { rerender } = render(
      <CheckCommands runKey="run-1" commands={[]} visit={visitView({ status: 'done' })} now={0} />,
    );
    expect(screen.getByText('This visit has no check commands.')).toBeInTheDocument();

    rerender(<CheckCommands runKey="run-1" commands={[]} visit={visit} now={0} />);
    expect(screen.queryByText(/no check commands/)).toBeNull();
  });
});
