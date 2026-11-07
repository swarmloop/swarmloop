import type { DataSource, EntityManager } from 'typeorm';

const tails = new WeakMap<DataSource, Promise<unknown>>();

/** One transaction at a time per connection: SQLite refuses to start one inside another. */
export function transaction<T>(dataSource: DataSource, work: (manager: EntityManager) => Promise<T>): Promise<T> {
  const run = (tails.get(dataSource) ?? Promise.resolve()).then(() => dataSource.transaction(work));
  tails.set(
    dataSource,
    run.catch(() => undefined),
  );
  return run;
}
