import { RunEntity } from '../history/entities';
import { containerLockBody } from './chat-lock';
import { settleShell } from './shell-lock';

function feature(status = 'running'): RunEntity {
  return { key: 'PROJ-1', status, ownerPid: null } as RunEntity;
}

describe('shell lock', () => {
  it('keeps a new lock while the container is still starting', async () => {
    const notes: string[] = [];
    const current = feature();
    const history = {
      latestBody: async () => containerLockBody('waiting', 'swarmloop-proj-1-shell', Date.now()),
      saveRun: async (value: RunEntity) => value,
      putDocument: async () => {
        notes.push('clear');
      },
    };
    const settled = await settleShell(history as never, { containerExists: async () => false }, current);
    expect(settled.status).toBe('running');
    expect(notes).toEqual([]);
  });

  it('clears a lock after the container is gone', async () => {
    const notes: string[] = [];
    const current = feature();
    const history = {
      latestBody: async () => containerLockBody('waiting', 'swarmloop-proj-1-shell', Date.now() - 60_000),
      saveRun: async (value: RunEntity) => {
        notes.push(value.status);
        return value;
      },
      putDocument: async () => {
        notes.push('clear');
      },
    };
    const settled = await settleShell(history as never, { containerExists: async () => false }, current);
    expect(settled.status).toBe('waiting');
    expect(notes).toEqual(['waiting', 'clear']);
  });

  it('keeps the lock while the container is running', async () => {
    const current = feature();
    const history = {
      latestBody: async () => containerLockBody('waiting', 'swarmloop-proj-1-shell', Date.now() - 60_000),
      saveRun: async (value: RunEntity) => value,
      putDocument: async () => undefined,
    };
    const settled = await settleShell(history as never, { containerExists: async () => true }, current);
    expect(settled.status).toBe('running');
  });
});
