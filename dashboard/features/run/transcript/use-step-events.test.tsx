import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getStepEvents } from '../../../lib/endpoints';
import { QueryWrapper } from '../../../test/query-wrapper';
import { stepEvent } from '../../../test/step-events';
import { useStepEvents } from './use-step-events';

vi.mock('../../../lib/endpoints', () => ({ getStepEvents: vi.fn() }));

const done = (seq: number) => stepEvent(seq, { kind: 'attempt.finished', route: 'next', summary: `done ${seq}` });

function Probe({ cursor, step = 'implement' }: { cursor: number | null; step?: string }) {
  const { events, error } = useStepEvents('run-1', step, cursor);
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

    render(<Probe cursor={3} />, { wrapper: QueryWrapper });

    expect(await screen.findByText('1,2,3')).toBeInTheDocument();
    expect(getStepEvents).toHaveBeenNthCalledWith(1, 'run-1', 'implement', 0);
    expect(getStepEvents).toHaveBeenNthCalledWith(2, 'run-1', 'implement', 2);
  });

  it('reads nothing before the step has a cursor', () => {
    render(<Probe cursor={null} />, { wrapper: QueryWrapper });

    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(getStepEvents).not.toHaveBeenCalled();
  });

  it('reads again when the cursor moves', async () => {
    vi.mocked(getStepEvents).mockResolvedValueOnce({ events: [done(1)], next: null });
    const view = render(<Probe cursor={1} />, { wrapper: QueryWrapper });
    await screen.findByText('1');

    vi.mocked(getStepEvents).mockResolvedValueOnce({ events: [done(1), done(2)], next: null });
    view.rerender(<Probe cursor={2} />);

    expect(await screen.findByText('1,2')).toBeInTheDocument();
  });

  it('shows the message of a failed read', async () => {
    vi.mocked(getStepEvents).mockRejectedValue(new Error('events are gone'));

    render(<Probe cursor={1} />, { wrapper: QueryWrapper });

    expect(await screen.findByText('events are gone')).toBeInTheDocument();
  });

  it('keeps the events of the same step while a new cursor is read, and drops them for another step', async () => {
    vi.mocked(getStepEvents).mockResolvedValueOnce({ events: [done(1)], next: null });
    const view = render(<Probe cursor={1} />, { wrapper: QueryWrapper });
    await screen.findByText('1');

    vi.mocked(getStepEvents).mockReturnValueOnce(new Promise(() => {}));
    view.rerender(<Probe cursor={2} />);
    expect(screen.getByText('1')).toBeInTheDocument();

    vi.mocked(getStepEvents).mockReturnValueOnce(new Promise(() => {}));
    view.rerender(<Probe cursor={2} step="commit" />);
    expect(screen.getByText('loading')).toBeInTheDocument();
  });
});
