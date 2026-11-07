import { act, render, screen } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStepEvents } from '../../../lib/endpoints';
import { receive, resetFakeSocket } from '../../../test/fake-socket';
import { QueryWrapper } from '../../../test/query-wrapper';
import { LiveBridgeProvider, useLiveActions } from '../../shell';
import { stepEvent } from '../../../test/step-events';
import { useStepEvents } from './use-step-events';

vi.mock('../../../lib/endpoints', () => ({ getStepEvents: vi.fn() }));
vi.mock('../../../lib/live', async () => (await import('../../../test/fake-socket')).fakeLive());

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryWrapper>
      <LiveBridgeProvider>{children}</LiveBridgeProvider>
    </QueryWrapper>
  );
}

afterEach(() => {
  resetFakeSocket();
  vi.useRealTimers();
});

const done = (seq: number) => stepEvent(seq, { kind: 'attempt.finished', route: 'next', summary: `done ${seq}` });

function Probe({
  cursor,
  step = 'implement',
  running = false,
}: {
  cursor: number | null;
  step?: string;
  running?: boolean;
}) {
  const { watchRun } = useLiveActions();
  useEffect(() => watchRun('run-1'), [watchRun]);
  const { events, error } = useStepEvents('run-1', step, cursor, running);
  return (
    <div>
      {events ? <p>{events.map((event) => event.seq).join(',')}</p> : <p>loading</p>}
      {error ? <p>{error}</p> : null}
    </div>
  );
}

describe('useStepEvents', () => {
  it('reads every page until there is no next one, in seq order', async () => {
    vi.mocked(getStepEvents)
      .mockResolvedValueOnce({ events: [done(1), done(2)], next: 2 })
      .mockResolvedValueOnce({ events: [done(3)], next: null });

    render(<Probe cursor={3} />, { wrapper: Wrapper });

    expect(await screen.findByText('1,2,3')).toBeInTheDocument();
    expect(getStepEvents).toHaveBeenNthCalledWith(1, 'run-1', 'implement', 0);
    expect(getStepEvents).toHaveBeenNthCalledWith(2, 'run-1', 'implement', 2);
  });

  it('reads nothing before the step has a cursor', () => {
    render(<Probe cursor={null} />, { wrapper: Wrapper });

    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(getStepEvents).not.toHaveBeenCalled();
  });

  it('reads only what is past the last held seq when the cursor moves', async () => {
    vi.mocked(getStepEvents).mockResolvedValueOnce({ events: [done(1)], next: null });
    const view = render(<Probe cursor={1} />, { wrapper: Wrapper });
    await screen.findByText('1');

    vi.mocked(getStepEvents).mockResolvedValueOnce({ events: [done(2)], next: null });
    view.rerender(<Probe cursor={2} />);

    expect(await screen.findByText('1,2')).toBeInTheDocument();
    expect(getStepEvents).toHaveBeenLastCalledWith('run-1', 'implement', 1);
  });

  it('shows the message of a failed read', async () => {
    vi.mocked(getStepEvents).mockRejectedValue(new Error('events are gone'));

    render(<Probe cursor={1} />, { wrapper: Wrapper });

    expect(await screen.findByText('events are gone')).toBeInTheDocument();
  });

  it('keeps the events of the same step while a new cursor is read, and drops them for another step', async () => {
    vi.mocked(getStepEvents).mockResolvedValueOnce({ events: [done(1)], next: null });
    const view = render(<Probe cursor={1} />, { wrapper: Wrapper });
    await screen.findByText('1');

    vi.mocked(getStepEvents).mockReturnValueOnce(new Promise(() => {}));
    view.rerender(<Probe cursor={2} />);
    expect(screen.getByText('1')).toBeInTheDocument();

    vi.mocked(getStepEvents).mockReturnValueOnce(new Promise(() => {}));
    view.rerender(<Probe cursor={2} step="commit" />);
    expect(screen.getByText('loading')).toBeInTheDocument();
  });

  it('appends what each live events message announces, reading after the last held seq', async () => {
    vi.mocked(getStepEvents).mockResolvedValueOnce({ events: [done(1)], next: null });
    render(<Probe cursor={1} running />, { wrapper: Wrapper });
    await screen.findByText('1');

    for (const seq of [2, 3, 4]) {
      vi.mocked(getStepEvents).mockResolvedValueOnce({ events: [done(seq)], next: null });
      act(() => receive('events', { key: 'run-1', step: 'implement', seq }));
      expect(await screen.findByText(new RegExp(`${seq}$`))).toBeInTheDocument();
      expect(getStepEvents).toHaveBeenLastCalledWith('run-1', 'implement', seq - 1);
    }
    expect(getStepEvents).toHaveBeenCalledTimes(4);
  });

  it('ignores a message of another step or run', async () => {
    vi.mocked(getStepEvents).mockResolvedValueOnce({ events: [done(1)], next: null });
    render(<Probe cursor={1} running />, { wrapper: Wrapper });
    await screen.findByText('1');

    act(() => receive('events', { key: 'run-1', step: 'commit', seq: 2 }));
    act(() => receive('events', { key: 'run-2', step: 'implement', seq: 2 }));

    expect(getStepEvents).toHaveBeenCalledTimes(1);
  });

  describe('with the socket down', () => {
    async function polling(running: boolean) {
      vi.mocked(getStepEvents).mockResolvedValue({ events: [], next: null });
      vi.mocked(getStepEvents).mockResolvedValueOnce({ events: [done(1)], next: null });
      const view = render(<Probe cursor={1} />, { wrapper: Wrapper });
      await screen.findByText('1');
      vi.mocked(getStepEvents).mockClear();
      // The interval must be made under fake timers, so the visit starts running only now.
      vi.useFakeTimers();
      view.rerender(<Probe cursor={1} running={running} />);
      return view;
    }

    it('polls every 3 s while the visit runs', async () => {
      await polling(true);

      await act(() => vi.advanceTimersByTimeAsync(2900));
      expect(getStepEvents).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(getStepEvents).toHaveBeenCalledTimes(1);
      expect(getStepEvents).toHaveBeenLastCalledWith('run-1', 'implement', 1);
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(getStepEvents).toHaveBeenCalledTimes(2);
    });

    it('stops when the socket is back', async () => {
      await polling(true);

      act(() => receive('connect'));
      await act(() => vi.advanceTimersByTimeAsync(9000));

      expect(getStepEvents).not.toHaveBeenCalled();
    });

    it('stops when the visit ends', async () => {
      const view = await polling(true);

      view.rerender(<Probe cursor={1} running={false} />);
      await act(() => vi.advanceTimersByTimeAsync(9000));

      expect(getStepEvents).not.toHaveBeenCalled();
    });

    it('does not poll a visit that is not running', async () => {
      await polling(false);

      await act(() => vi.advanceTimersByTimeAsync(9000));

      expect(getStepEvents).not.toHaveBeenCalled();
    });
  });
});
