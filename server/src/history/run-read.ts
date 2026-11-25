import { EventSubscriber } from 'typeorm';
import type { EntitySubscriberInterface } from 'typeorm';
import { RunEntity } from './entities';

/** The value of a column as the copy read it: an object column by its JSON, so a change inside it shows. */
function snapshotOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
}

/** What each copy of a run read, by copy. A spread or a new copy has no record. */
const reads = new WeakMap<RunEntity, Map<string, unknown>>();

function record(run: RunEntity, row: Partial<RunEntity>): void {
  reads.set(run, new Map(Object.entries(row).map(([column, value]) => [column, snapshotOf(value)])));
}

/** Keeps what every loaded run copy read, in this one place, so a write can set only what its writer changed. */
@EventSubscriber()
export class RunReadSubscriber implements EntitySubscriberInterface<RunEntity> {
  listenTo(): typeof RunEntity {
    return RunEntity;
  }

  afterLoad(entity: RunEntity): void {
    record(entity, entity);
  }
}

/** True when the copy was loaded from the row, false for a copy that is not stored yet. */
export function wasRead(run: RunEntity): boolean {
  return reads.has(run);
}

/**
 * The columns of the copy, except its id, whose value differs from what the copy read.
 * A copy that was never read has no such value: all its columns are returned.
 */
export function changedColumns(run: RunEntity): Partial<RunEntity> {
  const read = reads.get(run);
  const { id: _id, ...columns } = run;
  const changed = Object.entries(columns).filter(([column, value]) => !read || read.get(column) !== snapshotOf(value));
  return Object.fromEntries(changed);
}

/** Makes the copy the stored row, and what it read the stored row too. */
export function adoptRow(run: RunEntity, stored: RunEntity): void {
  Object.assign(run, stored);
  record(run, stored);
}
