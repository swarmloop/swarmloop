import { ConflictException } from '@nestjs/common';
import { HostUnavailable, SwarmloopError } from '../core/swarmloop-error';
import { RunRebaseService } from './run-rebase.service';

const OUTAGE = new HostUnavailable('api.github.com', 'HTTP 503', '2026-11-12T15:00:00.000Z');

function serviceWith(rebase: () => Promise<'resume' | 'start'>): RunRebaseService {
  return new RunRebaseService(
    { rebase } as never,
    {} as never,
    {} as never,
    { findRun: async () => null } as never,
    {} as never,
    {} as never,
  );
}

function startingWith(next: 'resume' | 'start') {
  const seen: { resume?: unknown; start?: unknown } = {};
  const service = new RunRebaseService(
    { rebase: async () => next } as never,
    {
      startDetached: async (_key: string, options: unknown) => {
        seen.start = options;
        return { exitCode: 0, message: 'started' };
      },
    } as never,
    {
      resume: async (_key: string, _prompt: unknown, start: unknown) => {
        seen.resume = start;
        return { key: 'PROJ-1', status: 'started' };
      },
      accepted: async (key: string) => ({ key, status: 'started' }),
    } as never,
    { findRun: async () => null } as never,
    {} as never,
    {} as never,
  );
  return { service, seen };
}

/** A service for a split epic: what its rebase answers, and every call to the rebase and to the subtasks. */
function splitEpic(next: 'resume' | 'start' | 'stay' | 'resolve') {
  const seen = {
    rebase: [] as unknown[][],
    moved: [] as unknown[][],
    resume: undefined as unknown,
    start: undefined as unknown,
  };
  const run = { key: 'PROJ-1', split: true };
  const service = new RunRebaseService(
    {
      rebase: async (...args: unknown[]) => {
        seen.rebase.push(args);
        return next;
      },
      tipOf: async () => 'demo@abc',
    } as never,
    {
      startDetached: async (_key: string, options: unknown) => {
        seen.start = options;
        return { exitCode: 0, message: 'started' };
      },
    } as never,
    {
      accepted: async (key: string) => ({ key, status: 'started' }),
      resume: async (_key: string, _prompt: unknown, start: unknown) => {
        seen.resume = start;
        return { key: 'PROJ-1', status: 'started' };
      },
    } as never,
    { findRun: async () => run } as never,
    { ensureForRequest: async () => undefined } as never,
    { rebaseOpen: async (...args: unknown[]) => void seen.moved.push(args) } as never,
  );
  return { service, seen, run };
}

describe('run rebase service', () => {
  it('moves the open subtasks of an epic after a main move, naming its new tip and why, and starts it as the machine', async () => {
    const { service, seen, run } = splitEpic('resume');
    await service.rebase('PROJ-1', false, 'demo at abc123');
    expect(seen.rebase[0]?.slice(2)).toEqual([false, true, false]);
    expect(seen.moved).toEqual([
      [run, { tip: 'demo@abc', note: 'rebased onto the epic after main moved on (demo at abc123)' }],
    ]);
    expect(seen.resume).toEqual({ by: 'machine', level: null });
  });

  it('moves no subtask when the epic stayed on its branch after a conflict with main', async () => {
    const { service, seen } = splitEpic('resolve');
    await service.rebase('PROJ-1', false, 'demo at abc123');
    expect(seen.moved).toEqual([]);
    expect(seen.start).toEqual({ startBy: 'machine' });
  });

  it("moves no subtask when a person's Rebase of an epic conflicts, and starts the run", async () => {
    const { service, seen } = splitEpic('resolve');
    await service.rebase('PROJ-1');
    expect(seen.moved).toEqual([]);
    expect(seen.start).toBeUndefined();
    expect(seen.rebase).toHaveLength(1);
  });

  it("starts and resumes nothing for a subtask that keeps its wait through its parent's rebase", async () => {
    const { service, seen } = splitEpic('stay');
    expect(await service.rebase('PROJ-1', true, undefined, true)).toEqual({ key: 'PROJ-1', status: 'waiting' });
    expect(seen.rebase[0]?.slice(2)).toEqual([true, false, true]);
    expect(seen.start).toBeUndefined();
    expect(seen.resume).toBeUndefined();
  });

  it("sends the open subtasks no event on a person's Rebase of an epic", async () => {
    const { service, seen, run } = splitEpic('resume');
    await service.rebase('PROJ-1');
    expect(seen.moved).toEqual([[run]]);
  });

  it("starts a parent's rebase of a task as the machine and a person's rebase with no start", async () => {
    const resumed = startingWith('resume');
    await resumed.service.rebase('PROJ-1', true);
    expect(resumed.seen.resume).toEqual({ by: 'machine', level: null });
    const started = startingWith('start');
    await started.service.rebase('PROJ-1', true);
    expect(started.seen.start).toEqual({ startBy: 'machine' });

    const person = startingWith('resume');
    await person.service.rebase('PROJ-1');
    expect(person.seen.resume).toBeUndefined();
    const personStart = startingWith('start');
    await personStart.service.rebase('PROJ-1');
    expect(personStart.seen.start).toBeUndefined();
  });

  it('tells a person who asks for a Rebase while the host is down the reason, as a conflict', async () => {
    const service = serviceWith(() => Promise.reject(OUTAGE));
    await expect(service.rebase('PROJ-1')).rejects.toThrow(new ConflictException(OUTAGE.message).message);
    await expect(service.rebase('PROJ-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps any other error as it is', async () => {
    const other = new SwarmloopError('nope');
    await expect(serviceWith(() => Promise.reject(other)).rebase('PROJ-1')).rejects.toBe(other);
  });
});
