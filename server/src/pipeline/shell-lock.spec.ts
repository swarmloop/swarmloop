import type { RunEntity } from '../history/entities';
import { containerLockBody } from './chat-lock';
import { SystemClock } from '../core/clock';
import { settleShell } from './shell-lock';

const clock = new SystemClock();

function feature(status = 'running'): RunEntity {
  return { key: 'PROJ-1', status, ownerPid: null } as RunEntity;
}

describe('shell lock', () => {
  it('keeps a new lock while the container is still starting', async () => {
    const notes: string[] = [];
    const current = feature();
    const runs = { saveRun: async (value: RunEntity) => value };
    const documents = {
      latestBody: async () => containerLockBody('waiting', 'swarmloop-proj-1-shell', Date.now()),
      putDocument: async () => {
        notes.push('clear');
      },
    };
    const settled = await settleShell(
      runs as never,
      documents as never,
      { containerExists: async () => false },
      current,
      clock,
    );
    expect(settled.status).toBe('running');
    expect(notes).toEqual([]);
  });

  it('clears a lock after the container is gone', async () => {
    const notes: string[] = [];
    const current = feature();
    const runs = {
      release: async (value: RunEntity, change: { status: string }) => {
        notes.push(change.status);
        return { ...value, status: change.status };
      },
    };
    const documents = {
      latestBody: async () => containerLockBody('waiting', 'swarmloop-proj-1-shell', Date.now() - 60_000),
      putDocument: async () => {
        notes.push('clear');
      },
    };
    const settled = await settleShell(
      runs as never,
      documents as never,
      { containerExists: async () => false },
      current,
      clock,
    );
    expect(settled.status).toBe('waiting');
    expect(notes).toEqual(['waiting', 'clear']);
  });

  it('keeps the lock while the container is running', async () => {
    const current = feature();
    const runs = { saveRun: async (value: RunEntity) => value };
    const documents = {
      latestBody: async () => containerLockBody('waiting', 'swarmloop-proj-1-shell', Date.now() - 60_000),
      putDocument: async () => undefined,
    };
    const settled = await settleShell(
      runs as never,
      documents as never,
      { containerExists: async () => true },
      current,
      clock,
    );
    expect(settled.status).toBe('running');
  });
});
