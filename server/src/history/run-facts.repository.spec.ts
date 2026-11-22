import { DataSource } from 'typeorm';
import { LiveHub } from '../live/live.hub';
import { repositoryDatabase } from './repository.spec-helpers';
import { RunEntity } from './run.entity';
import { RunFactsRepository } from './run-facts.repository';
import { RunRepository } from './run.repository';

const WAITING = {
  state: 'waiting',
  stateReason: JSON.stringify({ code: 'NEEDS_ANSWERS', message: 'waiting for a person' }),
};

async function setup() {
  const db = await repositoryDatabase();
  const dataSource = db.app.get(DataSource);
  const hub = new LiveHub();
  const facts = new RunFactsRepository(dataSource.getRepository(RunEntity), hub);
  const run = await db.app.get(RunRepository).openWaiting('run-1', '/target');
  const noticed: string[] = [];
  hub.onChanged((key) => noticed.push(key));
  const row = () => dataSource.getRepository(RunEntity).findOneByOrFail({ id: run.id });
  return { db, dataSource, facts, run, noticed, row };
}

describe('RunFactsRepository', () => {
  it('writes the columns without a new revision or update time, and tells the dashboard', async () => {
    const { db, facts, run, noticed, row } = await setup();
    try {
      const seen = await row();
      db.clock.advance(60_000);

      expect(await facts.recordFacts(seen, WAITING)).toBe(true);

      expect(await row()).toMatchObject({ ...WAITING, revision: seen.revision, updatedAt: seen.updatedAt });
      expect(noticed).toEqual([run.key]);
    } finally {
      await db.close();
    }
  });

  it('writes nothing when the columns are what the row has', async () => {
    const { db, facts, noticed, row } = await setup();
    try {
      const seen = await row();
      await facts.recordFacts(seen, WAITING);
      noticed.length = 0;

      expect(await facts.recordFacts(await row(), WAITING)).toBe(false);
      expect(noticed).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('writes nothing when the revision moved since the row was read', async () => {
    const { db, dataSource, facts, run, noticed, row } = await setup();
    try {
      const seen = await row();
      await dataSource.getRepository(RunEntity).update({ id: run.id }, { revision: seen.revision + 1 });

      expect(await facts.recordFacts(seen, WAITING)).toBe(false);
      expect((await row()).state).toBe(seen.state);
      expect(noticed).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('writes nothing when the status moved since the row was read', async () => {
    const { db, dataSource, facts, run, noticed, row } = await setup();
    try {
      const seen = await row();
      await dataSource.getRepository(RunEntity).update({ id: run.id }, { status: 'running' });

      expect(await facts.recordFacts(seen, WAITING)).toBe(false);
      expect((await row()).state).toBe(seen.state);
      expect(noticed).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
