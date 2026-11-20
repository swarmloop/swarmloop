import { cleanup, render, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../lib/api';
import { QueryWrapper } from '../../../test/query-wrapper';
import { stepEvent } from '../../../test/step-events';
import { LiveBridgeProvider } from '../../shell';
import { useStepEvents } from './use-step-events';

vi.mock('../../../lib/api', () => ({ api: vi.fn() }));
vi.mock('../../../lib/live', async () => (await import('../../../test/fake-socket')).fakeLive());

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryWrapper>
      <LiveBridgeProvider>{children}</LiveBridgeProvider>
    </QueryWrapper>
  );
}

afterEach(cleanup);

const done = (seq: number) => stepEvent(seq, { kind: 'attempt.finished', route: 'next', summary: `done ${seq}` });

function Probe() {
  const { events } = useStepEvents('run-1', 'implement', 3, false);
  return events ? <p>{events.map((event) => event.seq).join(',')}</p> : <p>loading</p>;
}

describe('useStepEvents page size', () => {
  it('asks for 500 events on every page and follows next', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ events: [done(1), done(2)], next: 2 })
      .mockResolvedValueOnce({ events: [done(3)], next: null });

    render(<Probe />, { wrapper: Wrapper });

    expect(await screen.findByText('1,2,3')).toBeInTheDocument();
    expect(vi.mocked(api).mock.calls).toEqual([
      ['/runs/run-1/events?step=implement&after=0&limit=500'],
      ['/runs/run-1/events?step=implement&after=2&limit=500'],
    ]);
  });
});
