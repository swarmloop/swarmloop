import { DataSource } from 'typeorm';
import { LiveHub } from '../live/live.hub';
import { repositoryDatabase } from './repository.spec-helpers';
import { RunEntity } from './run.entity';
import { RunRepository } from './run.repository';
import { RunWaitLog } from './run-wait.log';

async function setup() {
  const db = await repositoryDatabase();
  const dataSource = db.app.get(DataSource);
  const hub = new LiveHub();
  const log = new RunWaitLog(dataSource, db.clock, hub);
  const run = await db.app.get(RunRepository).openWaiting('run-1', '/target');
  const move = async (status: string, code?: string, extra: object = {}) => {
    const stateReason = code ? JSON.stringify({ code, message: code, ...extra }) : null;
    await dataSource.getRepository(RunEntity).update({ key: run.key }, { status, stateReason });
    hub.changed(run.key);
    await log.settled();
  };
  const stretches = async () => (await log.waitsOf([run.id])).get(run.id) ?? [];
  return { db, dataSource, hub, log, run, move, stretches };
}

describe('RunWaitLog', () => {
  it('opens a person stretch at the clock time and closes it when the run works again', async () => {
    const { db, log, move, stretches } = await setup();
    try {
      const opened = db.clock.iso();
      await move('blocked', 'NEEDS_ANSWERS');
      expect(await stretches()).toMatchObject([
        { kind: 'person', code: 'NEEDS_ANSWERS', startedAt: opened, endedAt: null },
      ]);
      db.clock.advance(60_000);
      await move('running');
      expect(await stretches()).toMatchObject([{ kind: 'person', startedAt: opened, endedAt: db.clock.iso() }]);
      await log.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('opens a timed stretch for a wait with a next try and none for a wait for an agent place', async () => {
    const { db, log, move, stretches } = await setup();
    try {
      await move('waiting', 'RUNTIME_LIMIT', { limit: { resumesAt: '2026-01-01T05:00:00.000Z' } });
      expect(await stretches()).toMatchObject([{ kind: 'timed', code: 'RUNTIME_LIMIT', endedAt: null }]);
      db.clock.advance(1000);
      await move('running', 'AGENT_PLACE');
      const rows = await stretches();
      expect(rows).toHaveLength(1);
      expect(rows[0].endedAt).toBe(db.clock.iso());
      await log.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('closes a stretch of another code before it opens the next one', async () => {
    const { db, log, move, stretches } = await setup();
    try {
      await move('blocked', 'NEEDS_ANSWERS');
      db.clock.advance(1000);
      await move('waiting', 'HOST_UNAVAILABLE', { retryAt: '2026-01-01T05:00:00.000Z' });
      expect(await stretches()).toMatchObject([
        { kind: 'person', endedAt: db.clock.iso() },
        { kind: 'timed', code: 'HOST_UNAVAILABLE', endedAt: null },
      ]);
      await log.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('closes the stretch of a run that is done and calls the finished listeners', async () => {
    const { db, log, move, stretches, run } = await setup();
    try {
      const finished: string[] = [];
      log.onFinished((key) => finished.push(key));
      await move('blocked', 'NEEDS_ANSWERS');
      db.clock.advance(1000);
      await move('done');
      expect((await stretches())[0].endedAt).toBe(db.clock.iso());
      expect(finished).toEqual([run.key]);
      await log.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('writes only its own table and sends no change notice', async () => {
    const { db, hub, log, move, run, dataSource } = await setup();
    try {
      const notices: string[] = [];
      await move('blocked', 'NEEDS_ANSWERS');
      const before = await dataSource.getRepository(RunEntity).findOneByOrFail({ id: run.id });
      hub.onChanged((key) => notices.push(key));
      hub.changed(run.key);
      await log.settled();
      expect(notices).toEqual([run.key]);
      expect(await dataSource.getRepository(RunEntity).findOneByOrFail({ id: run.id })).toEqual(before);
      await log.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('settles after the write of the change before it', async () => {
    const { db, hub, log, run, dataSource, stretches } = await setup();
    try {
      await dataSource
        .getRepository(RunEntity)
        .update({ key: run.key }, { status: 'blocked', stateReason: '{"code":"NEEDS_ANSWERS","message":"x"}' });
      hub.changed(run.key);
      expect(await stretches()).toEqual([]);
      await log.settled();
      expect(await stretches()).toHaveLength(1);
      await log.onModuleDestroy();
    } finally {
      await db.close();
    }
  });

  it('opens at start the stretch of a run that already waits for a person', async () => {
    const { db, dataSource, run, stretches } = await setup();
    try {
      await dataSource
        .getRepository(RunEntity)
        .update({ key: run.key }, { status: 'blocked', stateReason: '{"code":"NEEDS_ANSWERS","message":"x"}' });
      const fresh = new RunWaitLog(dataSource, db.clock);
      fresh.onApplicationBootstrap();
      await fresh.settled();
      expect(await stretches()).toMatchObject([{ kind: 'person', code: 'NEEDS_ANSWERS', endedAt: null }]);
    } finally {
      await db.close();
    }
  });

  it("leaves none of a run's stretches when the run is removed", async () => {
    const { db, log, move, run, stretches } = await setup();
    try {
      await move('blocked', 'NEEDS_ANSWERS');
      expect(await stretches()).toHaveLength(1);
      await db.app.get(RunRepository).remove(run);
      expect(await stretches()).toEqual([]);
      await log.onModuleDestroy();
    } finally {
      await db.close();
    }
  });
});
