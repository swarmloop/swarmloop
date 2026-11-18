import { EventEmitter } from 'events';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { SlowRequestRepository } from '../history/server-stall.repository';
import { enteredBefore } from '../core/entered-marks';
import { RequestTiming } from './request-timing';

interface Added {
  route: string;
  ms: number;
  at: string;
}

function setup(fail = false) {
  const clock = new FakeClock();
  const added: Added[] = [];
  const repository = {
    add: async (route: string, ms: number, at: string) => {
      if (fail && added.length === 0) {
        added.push({ route, ms: -1, at });
        throw new Error('disk full');
      }
      added.push({ route, ms, at });
    },
  } as unknown as SlowRequestRepository;
  const timing = new RequestTiming(clock, repository);
  async function request(takes: number, events: string[] = ['finish'], path = '/runs/:id'): Promise<void> {
    const req = { method: 'GET', path: `/api${path}`, baseUrl: '/api', route: { path } };
    const res = new EventEmitter();
    timing.middleware()(req, res, () => clock.advance(takes));
    for (const event of events) res.emit(event);
    await timing.onModuleDestroy();
  }
  return { added, request };
}

describe('RequestTiming', () => {
  it('counts a request of 1.5 s under its route', async () => {
    const { added, request } = setup();
    await request(1500);
    expect(added).toEqual([{ route: 'GET /api/runs/:id', ms: 1500, at: '2026-01-01T00:00:01.500Z' }]);
  });

  it('marks the arrival of a request as the last entered callback', async () => {
    const { request } = setup();
    await request(10, ['finish'], '/marked/:id');
    expect(enteredBefore(Date.now())).toBe('request GET /api/marked/:id');
  });

  it('does not count a request of 0.5 s', async () => {
    const { added, request } = setup();
    await request(500);
    expect(added).toEqual([]);
  });

  it('counts a request once when the response finishes and closes', async () => {
    const { added, request } = setup();
    await request(1500, ['finish', 'close']);
    expect(added).toHaveLength(1);
  });

  it('counts a request whose connection closed before the answer', async () => {
    const { added, request } = setup();
    await request(2000, ['close']);
    expect(added).toHaveLength(1);
  });

  it('keeps writing after a write failed', async () => {
    const { added, request } = setup(true);
    await request(1500);
    await request(1600);
    expect(added.map((entry) => entry.ms)).toEqual([-1, 1600]);
  });
});
