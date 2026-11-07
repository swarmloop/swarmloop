import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps, type ReactNode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveBridgeProvider, useLiveActions } from '../../../shell';
import { receive, resetFakeSocket } from '../../../../test/fake-socket';
import { QueryWrapper } from '../../../../test/query-wrapper';
import { getStep, getStepEvents } from '../../../../lib/endpoints';
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
      stepView({
        visits: [
          visitView({
            documents: [{ kind: 'log', attempt: 1, body: 'old log line', createdAt: '2026-01-01T00:00:00.000Z' }],
          }),
        ],
      }),
    );

    detail();

    expect(await screen.findByText('legacy: details not recorded')).toBeInTheDocument();
    expect(screen.getByText('old log line')).toBeInTheDocument();
  });
});
