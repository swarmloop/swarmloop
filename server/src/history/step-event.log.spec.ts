import { getRepositoryToken } from '@nestjs/typeorm';
import { LiveHub } from '../live/live.hub';
import type { StepEvent } from '../contract/step-events';
import { repositoryDatabase } from './repository.spec-helpers';
import { RunEntity, StepEventEntity } from './entities';
import { RunRepository } from './run.repository';
import { StepEventLog } from './step-event.log';

function event(seq: number, overrides: Partial<StepEvent> = {}): StepEvent {
  return {
    payloadVersion: 1,
    eventId: `event-${seq}`,
    runId: 1,
    attemptId: 'attempt-1',
    step: 'commit',
    seq,
    occurredAt: '2026-01-01T00:00:00.000Z',
    parentSpanId: null,
    kind: 'attempt.finished',
    route: 'ok',
    summary: `summary ${seq}`,
    ...overrides,
  } as StepEvent;
}

describe('StepEventLog', () => {
  let database: Awaited<ReturnType<typeof repositoryDatabase>>;
  let log: StepEventLog;

  beforeEach(async () => {
    database = await repositoryDatabase();
    log = database.app.get(StepEventLog);
  });

  afterEach(() => database.close());

  it('stores an event and reads it back with its payload', async () => {
    await log.append([event(1)]);
    expect(await log.page(1, {})).toEqual({ events: [event(1)], next: null });
    expect(await log.lastSeq(1)).toBe(1);
    expect(await log.lastSeq(2)).toBe(0);
  });

  it('masks a token in any string of the payload and keeps the JSON valid', async () => {
    await log.append([
      event(1, {
        kind: 'command.started',
        spanId: 's',
        actor: 'server',
        repo: 'demo',
        cwd: '.',
        executable: 'git',
        args: ['push', 'https://user:ghp_abcDEF123456@host/x.git', 'Authorization: Bearer abc.def'],
      }),
    ]);
    const [stored] = (await log.page(1, {})).events;
    expect(stored).toMatchObject({ args: ['push', 'https://***@host/x.git', 'Authorization: ***'] });
  });

  it('pages after a seq, for one step, at most 500 at a time', async () => {
    const events = Array.from({ length: 600 }, (_, index) =>
      event(index + 1, { step: index % 2 === 0 ? 'commit' : 'branch' }),
    );
    await log.append(events.slice(0, 300));
    await log.append(events.slice(300));
    const first = await log.page(1, { limit: 1000 });
    expect(first.events).toHaveLength(500);
    expect(first.next).toBe(500);
    const second = await log.page(1, { after: first.next ?? 0, limit: 1000 });
    expect(second.events.map(({ seq }) => seq)).toEqual(Array.from({ length: 100 }, (_, index) => 501 + index));
    expect(second.next).toBeNull();
    expect((await log.page(1, { limit: 0 })).events).toHaveLength(1);
    const branch = await log.page(1, { step: 'branch', after: 10, limit: 3 });
    expect(branch.events.map(({ seq }) => seq)).toEqual([12, 14, 16]);
    expect(branch.next).toBe(16);
  });

  it('refuses a second event with the same seq in a run', async () => {
    await log.append([event(1)]);
    await expect(log.append([event(1)])).rejects.toThrow();
    await log.append([event(1, { runId: 2 })]);
  });

  describe('live notification', () => {
    function announcing(): { log: StepEventLog; seen: unknown[] } {
      const hub = new LiveHub();
      const seen: unknown[] = [];
      hub.onEvents((entry) => seen.push(entry));
      const announcer = new StepEventLog(
        database.clock,
        database.config,
        database.app.get(getRepositoryToken(StepEventEntity)),
        database.app.get(getRepositoryToken(RunEntity)),
        hub,
      );
      return { log: announcer, seen };
    }

    it('announces a batch once, with the key, step and seq of its last event', async () => {
      const run = await database.app.get(RunRepository).openWaiting('run-1', '/target');
      const { log: announcer, seen } = announcing();
      await announcer.append([event(1, { runId: run.id }), event(2, { runId: run.id, step: 'implement' })]);
      expect(seen).toEqual([{ key: 'run-1', step: 'implement', seq: 2 }]);
    });

    it('announces nothing for an empty batch or a run without a row', async () => {
      const { log: announcer, seen } = announcing();
      await announcer.append([]);
      await announcer.append([event(1, { runId: 99 })]);
      expect(seen).toEqual([]);
      expect(await announcer.lastSeq(99)).toBe(1);
    });
  });
});
