import type { RunRepository } from './run.repository';

/** The login whose credentials a run uses: its own starter, or for a subtask the starter of its parent. Null for a run started by the CLI. */
export async function starterOf(
  runs: Pick<RunRepository, 'findById'>,
  run: { startedBy: string | null; parentRunId: number | null },
): Promise<string | null> {
  if (run.parentRunId === null) {
    return run.startedBy;
  }
  const parent = await runs.findById(run.parentRunId);
  return parent?.startedBy ?? null;
}
