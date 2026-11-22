import type { RunEntity } from '../history/entities';
import { chatLockBody, containerLockBody } from './chat-lock';
import { SystemClock } from '../core/clock';
import { settleChat, settleShell } from './shell-lock';

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

  describe('a stopped run', () => {
    const stopped = { code: 'STOPPED', message: 'stopped by a person' };

    function repositories(body: string) {
      const released: unknown[] = [];
      const runs = {
        release: async (value: RunEntity, change: unknown) => {
          released.push(change);
          return value;
        },
      };
      const documents = { latestBody: async () => body, putDocument: async () => undefined };
      return { released, runs, documents };
    }

    it('is given back stopped when a dead shell is settled', async () => {
      const { released, runs, documents } = repositories(
        containerLockBody('blocked', 'swarmloop-proj-1-shell', Date.now() - 60_000, stopped),
      );
      await settleShell(runs as never, documents as never, { containerExists: async () => false }, feature(), clock);
      expect(released).toEqual([{ status: 'blocked', reason: stopped }]);
    });

    it('is given back stopped when a dead chat is settled', async () => {
      const body = chatLockBody('blocked', 2_000_000_001, stopped);
      const { released, runs, documents } = repositories(body);
      const run = { ...feature(), ownerPid: 2_000_000_001 } as RunEntity;
      expect(await settleChat(runs as never, documents as never, run, body)).toBe(true);
      expect(released).toEqual([{ status: 'blocked', reason: stopped }]);
    });

    it('settles nothing while the chat process is alive', async () => {
      const body = chatLockBody('blocked', process.pid, stopped);
      const { released, runs, documents } = repositories(body);
      const run = { ...feature(), ownerPid: process.pid } as RunEntity;
      expect(await settleChat(runs as never, documents as never, run, body)).toBe(false);
      expect(released).toEqual([]);
    });
  });
});
