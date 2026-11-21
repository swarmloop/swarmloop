import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { DocumentRepository } from '../history/document.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { StatsRepository } from '../history/stats.repository';
import { StatsController } from './stats.controller';
import { meterDatabase } from './sqlite-meter.spec-helpers';
import { seedStatsFixture } from './stats-fixture.spec-helpers';

// Characters of string values SQLite returned to one report call over the 500-run fixture (counted with meterDatabase): 11_992_329 for the whole report, rounded up by about half.
const MAX_REPORT_CHARACTERS = 18_000_000;

async function metered(count?: number) {
  const db = await repositoryDatabase();
  const data = db.app.get(DataSource);
  const meter = meterDatabase(data);
  await seedStatsFixture(data, db.clock.now(), count);
  const controller = new StatsController(
    db.app.get(StatsRepository),
    db.app.get(RunRepository),
    db.app.get(DocumentRepository),
    db.clock,
  );
  return { db, data, meter, controller };
}

type Metered = Awaited<ReturnType<typeof metered>>;

async function reports({ meter, controller }: Metered) {
  const all = await meter.measure(() => controller.report('0', '0'));
  const last30 = await meter.measure(() => controller.report(undefined, '0'));
  return { all, last30 };
}

describe('StatsController', () => {
  let full: Metered;

  beforeAll(async () => {
    full = await metered();
  }, 60_000);

  afterAll(async () => {
    await full.db.close();
  });

  it('answers the report of 500 runs with the body stored from the code before, statements that do not grow with the runs and a bounded read', async () => {
    const small = await metered(50);
    try {
      const expected = JSON.parse(readFileSync(join(__dirname, 'stats-report.expected.json'), 'utf8'));
      const big = await reports(full);
      const few = await reports(small);

      expect({ all: big.all.result, last30: big.last30.result }).toEqual(expected);
      expect(big.all.statements).toBe(few.all.statements);
      expect(big.last30.statements).toBe(few.last30.statements);
      expect(big.all.characters).toBeLessThan(MAX_REPORT_CHARACTERS);
      expect(big.last30.characters).toBeLessThan(MAX_REPORT_CHARACTERS);
    } finally {
      await small.db.close();
    }
  }, 60_000);

  it('reads more than the report ceiling when every prompt and requirements body is read whole', async () => {
    const whole = await full.meter.measure(async () => {
      await full.data.query('SELECT prompt FROM runs');
      await full.data.query("SELECT body FROM documents WHERE kind = 'requirements'");
    });

    expect(whole.characters).toBeGreaterThan(MAX_REPORT_CHARACTERS);
  });

  it('counts one statement for one SELECT 1', async () => {
    const one = await full.meter.measure(() => full.data.query('SELECT 1'));

    expect(one.statements).toBe(1);
  });
});
