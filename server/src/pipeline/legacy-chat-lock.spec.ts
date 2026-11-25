import 'reflect-metadata';
import { storeRun } from '../testing/store-run.spec-helpers';
import { ERROR_CODES } from '../contract/error-codes';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import { createTestApp } from '../testing/test-app';
import { save } from '../testing/runs.spec-helpers';
import { SERVER_INSTANCE } from '../core/server-instance';
import { Reconciler } from './reconciler';

const REASON_LINE = JSON.stringify({ code: ERROR_CODES.GIT_AUTH, message: 'the git login was refused' });

const CONTAINER = 'swarmloop-proj-1-shell';

describe('a run that a lock written by a former version still holds', () => {
  async function boot(lock: string, own: { pid?: number; claimed?: boolean } = {}) {
    const removed: string[] = [];
    const world = await createTestApp({
      sandbox: {
        remove: async (name: string) => {
          removed.push(name);
        },
      },
    });
    const runs = world.app.get(RunRepository);
    const documents = world.app.get(DocumentRepository);
    const run = await save(runs, 'proj-1', 'implement', 'running');
    run.ownerPid = own.pid ?? process.pid;
    if (own.claimed) run.ownerInstance = SERVER_INSTANCE;
    await storeRun(runs, run);
    await documents.putDocument(run, 'chat_lock', lock);
    const start = () => world.app.get(Reconciler).start(() => own.claimed === true);
    return { world, runs, documents, removed, start };
  }

  const held: [string, string, string[]][] = [
    ['a pid lock', `waiting ${process.pid}\n${REASON_LINE}\n`, []],
    ['a container lock', `waiting container ${CONTAINER} 1700000000000\n${REASON_LINE}\n`, [CONTAINER]],
    ['a container lock of another container', `waiting container swarmloop-server-1\n${REASON_LINE}\n`, []],
  ];

  it.each(held)('gets back its status and reason at the first start, with %s', async (_name, lock, removes) => {
    const { world, runs, documents, removed, start } = await boot(lock);
    try {
      await start();
      await start();

      expect(storedState((await runs.findRun('proj-1'))!)).toMatchObject({
        state: 'waiting',
        reason: { code: ERROR_CODES.GIT_AUTH, message: 'the git login was refused' },
      });
      expect(await documents.latestBody('proj-1', 'chat_lock')).toBe('clear\n');
      expect(removed).toEqual(removes);
    } finally {
      await world.close();
    }
  });

  it('leaves a leftover pid lock of another pid alone', async () => {
    const lock = `waiting ${process.pid + 1}\n${REASON_LINE}\n`;
    const { world, runs, documents, removed, start } = await boot(lock);
    try {
      await start();

      expect(await documents.latestBody('proj-1', 'chat_lock')).toBe(lock);
      expect(storedState((await runs.findRun('proj-1'))!).reason?.code).not.toBe(ERROR_CODES.GIT_AUTH);
      expect(removed).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it('leaves a run that a step of this process holds alone', async () => {
    const lock = `waiting container ${CONTAINER}\n${REASON_LINE}\n`;
    const { world, runs, documents, removed, start } = await boot(lock, { claimed: true });
    try {
      await start();

      expect(await documents.latestBody('proj-1', 'chat_lock')).toBe(lock);
      expect(storedState((await runs.findRun('proj-1'))!).state).toBe('running');
      expect(removed).toEqual([]);
    } finally {
      await world.close();
    }
  });
});
