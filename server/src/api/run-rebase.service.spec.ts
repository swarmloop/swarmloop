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

describe('run rebase service', () => {
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
