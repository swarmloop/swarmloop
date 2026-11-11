import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps, type ReactNode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveBridgeProvider, useLiveActions } from '../../../shell';
import { receive, resetFakeSocket } from '../../../../test/fake-socket';
import { QueryWrapper } from '../../../../test/query-wrapper';
import { getRunLog, getStep, getStepEvents } from '../../../../lib/endpoints';
import { stepView, visitView } from '../../../../test/fixtures';
import { commandEvents, stepEvent } from '../../../../test/step-events';
import { StepDetail } from './index';

vi.mock('../../../../lib/endpoints', () => ({ getStep: vi.fn(), getStepEvents: vi.fn(), getRunLog: vi.fn() }));
vi.mock('../../../../lib/live', async () => (await import('../../../../test/fake-socket')).fakeLive());

function detail(overrides: Partial<ComponentProps<typeof StepDetail>> = {}) {
  render(
    <StepDetail
      runKey="run-1"
      step="implement"
      live={false}
      revision="2026-01-01T00:00:00.000Z"
      now={0}
      attempts={0}
      {...overrides}
    />,
    { wrapper: Wrapper },
  );
}

function Watch() {
  const { watchRun } = useLiveActions();
  useEffect(() => watchRun('run-1'), [watchRun]);
  return null;
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryWrapper>
      <LiveBridgeProvider>
        <Watch />
        {children}
      </LiveBridgeProvider>
    </QueryWrapper>
  );
}

beforeEach(() => {
  vi.mocked(getStepEvents).mockResolvedValue({ events: [], next: null });
  vi.mocked(getStep).mockResolvedValue(stepView());
});

afterEach(resetFakeSocket);

describe('StepDetail', () => {
  it('shows the step label once the step loads', async () => {
    detail();

    expect(await screen.findByText('implement')).toBeInTheDocument();
  });

  it('shows the load error text', async () => {
    vi.mocked(getStep).mockRejectedValue(new Error('step is gone'));

    detail();

    expect(await screen.findByText('step is gone')).toBeInTheDocument();
  });

  it('calls onReplay from Run again', async () => {
    const user = userEvent.setup();
    const onReplay = vi.fn();
    detail({ onReplay });

    await user.click(await screen.findByRole('button', { name: 'Run again' }));

    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  it('shows Resume only when onResume is passed', async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    detail({ onResume });

    await user.click(await screen.findByRole('button', { name: 'Resume' }));

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('hides Resume without onResume', async () => {
    detail();

    await screen.findByText('implement');
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

  it('shows recorded events as the transcript, with the error in place and linked from the header', async () => {
    vi.mocked(getStep).mockResolvedValue(
      stepView({
        eventsCursor: 3,
        visits: [
          visitView({
            documents: [
              { kind: 'error', attempt: 1, body: 'boom from the document', createdAt: '2026-01-01T00:00:00.000Z' },
            ],
            exchanges: [{ model: 'claude-opus', durationMs: 2500, request: 'a', response: 'b' }],
          }),
        ],
      }),
    );
    vi.mocked(getStepEvents).mockResolvedValue({
      events: commandEvents(1, 's', { executable: 'make', exitCode: 2 }),
      next: null,
    });

    detail();

    expect(await screen.findByRole('article', { name: 'Error: exit code 2' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Error/ })).toHaveAttribute('href', '#problem-event-1');
    expect(screen.queryByText('boom from the document')).not.toBeInTheDocument();
    expect(screen.queryByText('claude-opus · 2.5s')).not.toBeInTheDocument();
    expect(getStepEvents).toHaveBeenCalledWith('run-1', 'implement', 0);
  });

  it('reads the events of the run to link a received issue to its source', async () => {
    vi.mocked(getStep).mockResolvedValue(
      stepView({
        visits: [
          visitView({
            documents: [{ kind: 'issues', attempt: 1, body: '[{"id":"i-1"}]', createdAt: '2026-01-01T00:00:00.000Z' }],
          }),
        ],
      }),
    );
    vi.mocked(getStepEvents).mockImplementation((_key, name) =>
      Promise.resolve({
        events:
          name === null
            ? [
                stepEvent(
                  1,
                  { kind: 'issue.opened', issueId: 'i-1', source: 'pipeline', title: 'lint failed' },
                  { step: 'pipeline' },
                ),
              ]
            : [stepEvent(5, { kind: 'handoff.received', handoffId: 3, issueIds: ['i-1'] })],
        next: null,
      }),
    );

    detail();

    expect(await screen.findByRole('link', { name: 'lint failed' })).toHaveAttribute('href', '#problem-event-1');
    expect(getStepEvents).toHaveBeenCalledWith('run-1', null, 0);
  });

  it('shows the events of a running step as they arrive and never reads the whole list again', async () => {
    vi.mocked(getStep).mockResolvedValue(stepView({ eventsCursor: 2, visits: [visitView({ status: 'running' })] }));
    const all = [
      ...commandEvents(1, 'a', { executable: 'cmd-one' }),
      ...commandEvents(3, 'b', { executable: 'cmd-two' }),
      ...commandEvents(5, 'c', { executable: 'cmd-three' }),
      ...commandEvents(7, 'd', { executable: 'cmd-four' }),
    ];
    vi.mocked(getStepEvents).mockImplementation((_key, name, after) =>
      Promise.resolve({
        events: name === null ? [] : all.filter((event) => event.seq > (after ?? 0) && event.seq <= held),
        next: null,
      }),
    );
    let held = 2;

    detail();
    expect(await screen.findByText(/cmd-one/)).toBeInTheDocument();

    for (const [seq, name] of [
      [4, 'cmd-two'],
      [6, 'cmd-three'],
      [8, 'cmd-four'],
    ] as const) {
      held = seq;
      act(() => receive('events', { key: 'run-1', step: 'implement', seq }));
      expect(await screen.findByText(new RegExp(name))).toBeInTheDocument();
      expect(getStepEvents).toHaveBeenLastCalledWith('run-1', 'implement', seq - 2);
    }
    expect(screen.getByText(/cmd-one/)).toBeInTheDocument();
    // After the first load, no request reads the list from the start.
    const [, ...later] = vi.mocked(getStepEvents).mock.calls;
    expect(later).toHaveLength(3);
    expect(later.every(([, , after]) => (after ?? 0) > 0)).toBe(true);
  });

  it('keeps the log of a step with no events, marked legacy', async () => {
    vi.mocked(getStep).mockResolvedValue(
      stepView({ visits: [visitView({ attemptId: 'att-1', logBytes: 12, logLines: 1 })] }),
    );
    vi.mocked(getRunLog).mockResolvedValue('old log line\n');

    detail();

    expect(await screen.findByText('legacy: details not recorded')).toBeInTheDocument();
    expect(screen.getByText('old log line')).toBeInTheDocument();
  });

  describe('the log of a stored visit', () => {
    beforeEach(() => {
      vi.mocked(getStep).mockResolvedValue(
        stepView({
          visits: [
            visitView({ id: 1, attempt: 1, attemptId: 'att-1', logBytes: 30, logLines: 3 }),
            visitView({ id: 2, attempt: 2, attemptId: 'att-2', logBytes: 90_000, logLines: 5000 }),
          ],
        }),
      );
      vi.mocked(getRunLog).mockImplementation(async (_key, _step, attemptId, paging) =>
        attemptId === 'att-1' ? 'first visit line\n' : paging?.from ? 'earlier line\n' : 'latest visit line\n',
      );
    });

    it('fetches the last 2000 lines of the latest visit, and no other visit', async () => {
      detail();

      expect(await screen.findByText('latest visit line')).toBeInTheDocument();
      expect(getRunLog).toHaveBeenCalledTimes(1);
      expect(getRunLog).toHaveBeenCalledWith('run-1', 'implement', 'att-2', { tail: 2000 });
    });

    it('loads the 2000 lines before the first loaded one when the log is scrolled to the top', async () => {
      detail();
      fireEvent.scroll(await screen.findByText('latest visit line'));

      expect(await screen.findByText('earlier line')).toBeInTheDocument();
      expect(getRunLog).toHaveBeenLastCalledWith('run-1', 'implement', 'att-2', { from: 1001, tail: 2000 });
    });

    it('fetches the log of another visit only when that visit is opened', async () => {
      detail();
      await screen.findByText('latest visit line');
      expect(getRunLog).not.toHaveBeenCalledWith('run-1', 'implement', 'att-1', expect.anything());

      await userEvent.click(screen.getByRole('button', { name: '1' }));

      expect(await screen.findByText('first visit line')).toBeInTheDocument();
      expect(getRunLog).toHaveBeenLastCalledWith('run-1', 'implement', 'att-1', { tail: 2000 });
    });
  });

  describe('the resource chart of a step window', () => {
    it('shows the chart of the containers the visit started', async () => {
      vi.mocked(getStep).mockResolvedValue(
        stepView({
          visits: [
            visitView({ samples: [{ at: '2026-01-01T00:00:00.000Z', cpu: 12, memory: 1024, source: 'agent' }] }),
          ],
        }),
      );
      detail();

      expect(await screen.findByRole('img', { name: 'CPU and memory' })).toBeInTheDocument();
    });

    it('says so when the step started no container', async () => {
      vi.mocked(getStep).mockResolvedValue(
        stepView({
          step: 'branch',
          visits: [visitView({ samples: [] })],
          descriptor: { name: 'branch', kind: 'server' },
        }),
      );
      detail({ step: 'branch' });

      expect(await screen.findByText('This step started no container.')).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'CPU and memory' })).not.toBeInTheDocument();
    });
  });

  describe('the checks window', () => {
    const commands = [
      {
        attempt: 'att-1',
        index: 0,
        repo: 'api',
        command: 'npm test',
        status: 'passed',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:05.000Z',
        exitCode: 0,
      },
      {
        attempt: 'att-1',
        index: 1,
        repo: 'api',
        command: 'npm run lint',
        status: 'failed',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:02:03.000Z',
        exitCode: 2,
      },
      {
        attempt: 'att-1',
        index: 2,
        repo: 'web',
        command: 'npm run build',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: null,
        exitCode: null,
      },
      {
        attempt: 'att-1',
        index: 3,
        repo: 'web',
        command: 'npm run e2e',
        status: 'waiting',
        startedAt: null,
        endedAt: null,
        exitCode: null,
      },
      {
        attempt: 'att-1',
        index: 4,
        repo: 'web',
        command: 'npm run docs',
        status: 'skipped',
        startedAt: null,
        endedAt: null,
        exitCode: 0,
      },
      {
        attempt: 'att-0',
        index: 0,
        repo: 'api',
        command: 'npm test',
        status: 'failed',
        startedAt: null,
        endedAt: null,
        exitCode: 1,
      },
    ] as const;

    beforeEach(() => {
      vi.mocked(getStep).mockResolvedValue(
        stepView({
          step: 'checks',
          visits: [visitView({ attemptId: 'att-1', status: 'running' })],
          descriptor: { name: 'checks', kind: 'server' },
          commands: commands.map((command) => ({ ...command })),
        }),
      );
    });

    it('lists the commands of the visit with their status, duration and exit code', async () => {
      detail({ step: 'checks' });

      const table = await screen.findByRole('table', { name: 'Check commands' });
      const rows = within(table).getAllByRole('row').slice(1);
      expect(rows).toHaveLength(5);
      expect(rows.map((row) => within(row).getAllByRole('cell')[2]?.textContent)).toEqual([
        'passed',
        'failed',
        'running',
        'waiting',
        'skipped',
      ]);
      expect(within(rows[1]).getAllByRole('cell')[3]).toHaveTextContent('2m 3s');
      expect(within(rows[1]).getAllByRole('cell')[4]).toHaveTextContent('2');
    });

    it('shows passed/total and the slowest command in the header', async () => {
      detail({ step: 'checks' });

      expect(await screen.findByText(/^2\/5 passed · slowest: npm run lint 2m 3s$/)).toBeInTheDocument();
    });

    it('opens the full output of a finished command from its stored file', async () => {
      vi.mocked(getRunLog).mockResolvedValue('$ npm run lint\nerror: no-unused-vars\nexit 2\n');
      const user = userEvent.setup();
      detail({ step: 'checks' });

      await user.click(await screen.findByRole('button', { name: 'Show output of npm run lint' }));

      expect(await screen.findByLabelText('Output of npm run lint')).toHaveTextContent('error: no-unused-vars');
      expect(getRunLog).toHaveBeenCalledWith('run-1', 'checks', 'att-1', { command: 1 });
    });

    it('streams the output of a running command as it arrives', async () => {
      const user = userEvent.setup();
      detail({ step: 'checks' });
      await user.click(await screen.findByRole('button', { name: 'Show output of npm run build' }));

      act(() =>
        receive('log', {
          key: 'run-1',
          step: 'checks',
          command: 2,
          body: '$ npm run build\ncompiling 12 files\n',
          samples: [],
        }),
      );

      expect(await screen.findByLabelText('Output of npm run build')).toHaveTextContent('compiling 12 files');
      expect(getRunLog).not.toHaveBeenCalled();
    });
  });
});
