import type { PipelineCheck, PipelineRun, PipelineSnapshot } from './code-host';

const GREEN = ['success', 'skipped'];

/** The status of a commit from the statuses of its runs and app checks. `none` when it has none; `skipped` only when all are. */
function aggregateStatus(statuses: string[]): string {
  if (statuses.length === 0) {
    return 'none';
  }
  const worst = ['failed', 'canceled', 'manual'].find((status) => statuses.includes(status));
  if (worst) {
    return worst;
  }
  if (statuses.some((status) => !GREEN.includes(status))) {
    return 'running';
  }
  return statuses.every((status) => status === 'skipped') ? 'skipped' : 'success';
}

/** The commit-level snapshot, or null when the commit has no run and no app check. Job checks are not counted twice. */
export function snapshotOf(runs: PipelineRun[], checks: PipelineCheck[], awaiting: string[]): PipelineSnapshot | null {
  const app = checks.filter((check) => !check.workflow);
  const status = aggregateStatus([...runs.map((run) => run.status), ...app.map((check) => check.status)]);
  if (status === 'none') {
    return null;
  }
  const red = runs.find((run) => run.status === 'failed' || run.status === 'canceled');
  const failedApp = app.find((check) => check.status === 'failed');
  const lead = red ?? (failedApp ? undefined : runs[0]);
  return {
    id: red?.id ?? failedApp?.id ?? runs[0]?.id ?? checks[0]?.id ?? 0,
    status,
    url: red?.url ?? failedApp?.url ?? runs[0]?.url ?? '',
    jobs: lead?.jobs ?? [],
    runs,
    checks,
    awaiting,
  };
}
