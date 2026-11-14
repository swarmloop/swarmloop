import type { DataSource, EntitySubscriberInterface, InsertEvent, UpdateEvent } from 'typeorm';
import { RunEntity } from '../history/entities';

/** The `status` of every write of a run row, in the order the database saw them. */
export interface RunWrites {
  statuses: string[];
  stop(): void;
}

/**
 * Records each insert and update of a run row until `stop()` is called. An update that does not set `status`
 * (a revision bump) is not recorded. A query-builder update carries its values as the event entity.
 */
export function recordRunWrites(dataSource: DataSource): RunWrites {
  const statuses: string[] = [];
  const record = (written: Partial<RunEntity> | undefined): void => {
    if (typeof written?.status === 'string') statuses.push(written.status);
  };
  const subscriber: EntitySubscriberInterface<RunEntity> = {
    listenTo: () => RunEntity,
    afterInsert: (event: InsertEvent<RunEntity>) => record(event.entity),
    afterUpdate: (event: UpdateEvent<RunEntity>) => record(event.entity),
  };
  dataSource.subscribers.push(subscriber);
  return {
    statuses,
    stop: () => {
      const index = dataSource.subscribers.indexOf(subscriber);
      if (index >= 0) dataSource.subscribers.splice(index, 1);
    },
  };
}
