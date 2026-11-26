import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckCommandView } from '@contract/api';
import { getRunLog } from '../../../../lib/endpoints';
import { receive } from '../../../../test/fake-socket';
import { visitView } from '../../../../test/fixtures';
import { QueryWrapper } from '../../../../test/query-wrapper';
import { LiveBridgeProvider, useLiveActions } from '../../../shell';
import { NO_SAMPLES_AFTER_RESTART } from '@contract/restart-wait';
import { statusColor } from '../../../../theme/theme';
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

function Watching(): null {
  const { watchRun } = useLiveActions();
  useEffect(() => watchRun('run-1'), [watchRun]);
  return null;
}

function list(commands: CheckCommandView[]) {
  render(
    <LiveBridgeProvider>
      <Watching />
      <CheckCommands runKey="run-1" commands={commands} visit={visit} now={0} />
    </LiveBridgeProvider>,
    { wrapper: QueryWrapper },
  );
}

beforeEach(() => {
  vi.mocked(getRunLog).mockResolvedValue('all green\n');
});

describe('CheckCommands', () => {
  it('reads an interrupted row in words, in the neutral color, with its stored log and a fixed duration', async () => {
    list([
      row({ index: 2, status: 'interrupted', endedAt: '2026-01-01T00:01:05.000Z', exitCode: null }),
      row({ index: 1, name: 'lint' }),
    ]);

    const word = screen.getByText('interrupted by a server restart');
    expect(word).toHaveStyle({ color: statusColor('interrupted') });
    expect(screen.getByText('1m 5s')).toBeInTheDocument();
    expect(screen.getByText('passed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Show unit tests/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('Output of npm run test:unit -- --coverage')).toHaveTextContent('all green'),
    );
    expect(screen.getByText(NO_SAMPLES_AFTER_RESTART)).toBeInTheDocument();
  });

  it('says an interrupted row with no stored output did not run, and does not keep loading', async () => {
    vi.mocked(getRunLog).mockResolvedValue(null);
    list([row({ status: 'interrupted', startedAt: null, endedAt: '2026-01-01T00:01:05.000Z', exitCode: null })]);

    await userEvent.click(screen.getByRole('button', { name: /Show unit tests/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('Output of npm run test:unit -- --coverage')).toHaveTextContent(
        'no output: it did not run',
      ),
    );
  });

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

  it('shows the place in the line of a waiting command when its line is opened', async () => {
    const user = userEvent.setup({ delay: null });
    list([row({ status: 'waiting', startedAt: null, endedAt: null, exitCode: null })]);
    act(() =>
      receive('log', {
        key: 'run-1',
        step: 'checks',
        command: 0,
        body: 'waiting for a free check slot (1 ahead)\n',
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Show unit tests' }));

    expect(await screen.findByLabelText('Output of npm run test:unit -- --coverage')).toHaveTextContent(
      'waiting for a free check slot (1 ahead)',
    );
  });

  it('shows the latest live line of a waiting command in place of queued', () => {
    list([row({ status: 'waiting', startedAt: null, endedAt: null, exitCode: null })]);
    expect(screen.getByText('queued')).toBeInTheDocument();

    act(() =>
      receive('log', { key: 'run-1', step: 'checks', command: 0, body: 'waiting for a free check slot (2 ahead)\n' }),
    );

    expect(screen.getByText('waiting for a free check slot (2 ahead)')).toBeInTheDocument();
    expect(screen.queryByText('queued')).toBeNull();
  });

  describe('a skipped row', () => {
    const skipRecord = (command: string, tail: string) => ({
      kind: 'checks',
      attempt: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      body: JSON.stringify({ repo: 'api', command, name: 'x', skipped: true, exitCode: 0, tail }),
    });
    const skipped = (index: number, name: string) =>
      row({ index, name, command: `cmd ${index}`, status: 'skipped', startedAt: null, endedAt: null });
    const withDocuments = visitView({
      attemptId: 'att-1',
      status: 'running',
      documents: [skipRecord('cmd 0', 'no change in its paths')],
    });

    it('is muted with its reason, has no output box, and sorts after the commands that run', () => {
      render(
        <LiveBridgeProvider>
          <Watching />
          <CheckCommands
            runKey="run-1"
            commands={[
              skipped(0, 'lint'),
              row({ index: 1, name: 'tests', status: 'waiting', startedAt: null, endedAt: null }),
            ]}
            visit={withDocuments}
            now={0}
          />
        </LiveBridgeProvider>,
        { wrapper: QueryWrapper },
      );

      const disabled = createTheme().palette.text.disabled;
      expect(screen.getByText('lint')).toHaveStyle({ color: disabled });
      expect(screen.getByText('skipped · no change in its paths')).toHaveStyle({ color: disabled });
      expect(screen.queryByRole('button', { name: /lint/ })).toBeNull();
      expect(screen.queryByLabelText(/Output of cmd 0/)).toBeNull();
      expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        expect.stringContaining('tests'),
        expect.stringContaining('lint'),
      ]);
    });

    it('says skipped alone when no record names it', () => {
      list([skipped(0, 'lint')]);

      expect(screen.getByText('skipped')).toBeInTheDocument();
    });
  });

  it('opens a line in place to its full command, output and own chart', async () => {
    const user = userEvent.setup({ delay: null });
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

describe('CheckCommands list box', () => {
  it('scrolls the lines inside its own box', () => {
    list([row({ command: 'npm run test:unit -- --coverage --reporter verbose --shard 1/20 --long-flag-name' })]);

    const box = screen.getByRole('list', { name: 'Check commands' }).parentElement;
    expect(box).toHaveStyle({ overflowX: 'auto', minWidth: '0' });
  });
});
