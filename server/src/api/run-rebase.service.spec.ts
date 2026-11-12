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

describe('run rebase service', () => {
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
