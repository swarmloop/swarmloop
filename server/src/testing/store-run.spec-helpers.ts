import type { RunRepository } from '../history/run.repository';
import type { RunEntity } from '../history/entities';
import { adoptRow, changedColumns, wasRead } from '../history/run-read';

/** Test-only way to store a run copy and make it the stored row. Returns the same object. */
export async function storeRun(runs: RunRepository, run: RunEntity): Promise<RunEntity> {
  if (wasRead(run)) {
    const changed = changedColumns(run);
    adoptRow(run, await runs.change(run.key, (row) => Object.assign(row, changed)));
    return run;
  }
  if (run.id !== undefined && (await runs.findById(run.id))) {
    const { id: _id, ...columns } = run;
    adoptRow(run, await runs.change(run.key, (row) => Object.assign(row, columns)));
    return run;
  }
  return runs.insertRun(run);
}
