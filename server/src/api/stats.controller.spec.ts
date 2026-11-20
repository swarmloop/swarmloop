import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { DocumentRepository } from '../history/document.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { StatsRepository } from '../history/stats.repository';
import { seedStatsFixture, STATS_NOW } from './stats-fixture.spec-helpers';
import { StatsController } from './stats.controller';

const EXPECTED = join(__dirname, 'stats-report.expected.json');
const LIMIT_MS = 500;

describe('StatsController over a large history', () => {
  it('answers the report in under half a second, with the stored report', async () => {
    const db = await repositoryDatabase();
    try {
      await seedStatsFixture(db.app.get(DataSource));
      const controller = new StatsController(
        db.app.get(StatsRepository),
        db.app.get(RunRepository),
        db.app.get(DocumentRepository),
        new FakeClock(STATS_NOW),
      );
      const allStart = performance.now();
      const all = await controller.report('0', '0');
      const allMs = performance.now() - allStart;
      const lastStart = performance.now();
      const last30 = await controller.report(undefined, '0');
      const lastMs = performance.now() - lastStart;
      const expected = JSON.parse(readFileSync(EXPECTED, 'utf8')) as { all: unknown; last30: unknown };
      expect(all).toEqual(expected.all);
      expect(last30).toEqual(expected.last30);
      expect(allMs).toBeLessThan(LIMIT_MS);
      expect(lastMs).toBeLessThan(LIMIT_MS);
    } finally {
      await db.close();
    }
  }, 60_000);
});
