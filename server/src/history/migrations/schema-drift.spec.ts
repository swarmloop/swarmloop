import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { historyDatabaseOptions } from '../history.module';

describe('history migrations', () => {
  it('match the entities, so a fresh migrated database needs no schema change', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarmloop-drift-'));
    const dataSource = new DataSource(historyDatabaseOptions(directory));
    try {
      await dataSource.initialize();
      const { upQueries } = await dataSource.driver.createSchemaBuilder().log();
      expect(upQueries.map((query) => query.query)).toEqual([]);
    } finally {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
