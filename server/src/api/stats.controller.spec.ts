import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { DocumentRepository } from '../history/document.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { StatsRepository } from '../history/stats.repository';
import { StatsController } from './stats.controller';
import { seedStatsFixture } from './stats-fixture.spec-helpers';

const BUDGET_MS = 500;

describe('StatsController', () => {
  it('answers the report of 500 runs in under half a second, with the body stored from the code before', async () => {
    const db = await repositoryDatabase();
    try {
      await seedStatsFixture(db.app.get(DataSource), db.clock.now());
      const controller = new StatsController(
        db.app.get(StatsRepository),
        db.app.get(RunRepository),
        db.app.get(DocumentRepository),
        db.clock,
      );
      const expected = JSON.parse(readFileSync(join(__dirname, 'stats-report.expected.json'), 'utf8'));

      const everyStart = performance.now();
      const all = await controller.report('0', '0');
      const everyMs = performance.now() - everyStart;
      const lastStart = performance.now();
      const last30 = await controller.report(undefined, '0');
      const lastMs = performance.now() - lastStart;

      expect(everyMs).toBeLessThan(BUDGET_MS);
      expect(lastMs).toBeLessThan(BUDGET_MS);
      expect({ all, last30 }).toEqual(expected);
    } finally {
      await db.close();
    }
  }, 60_000);
});
