import type { RunSummary } from '@contract/api';
import type { LiveRunUsage } from '@contract/live';

/** The held rows after a usage entry: the row of the entry's run takes its cost, and its epic total when the entry has one. Every other row stays as it is. */
export function applyUsage(rows: RunSummary[], entry: LiveRunUsage): RunSummary[] {
  return rows.map((row) =>
    row.key === entry.key ? { ...row, usd: entry.usd, ...(entry.epic ? { epic: entry.epic } : {}) } : row,
  );
}
