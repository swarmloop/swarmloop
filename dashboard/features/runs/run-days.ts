import type { RunSummary } from '@contract/api';
import { dayLabel } from '../../lib/format';

/** The runs that are not shown under a parent, and each parent's subtasks in list order. */
export function nested(visible: RunSummary[]): { tops: RunSummary[]; children: Map<string, RunSummary[]> } {
  const keys = new Set(visible.map((run) => run.key));
  const children = new Map<string, RunSummary[]>();
  const tops: RunSummary[] = [];
  for (const run of visible) {
    if (run.parentKey && keys.has(run.parentKey)) {
      children.set(run.parentKey, [...(children.get(run.parentKey) ?? []), run]);
    } else {
      tops.push(run);
    }
  }
  return { tops, children };
}

/** The top-level runs under day headers by last change, newest day first, the incoming order kept inside a day. */
export function byDay(tops: RunSummary[], now: number): { label: string; runs: RunSummary[] }[] {
  const days = new Map<string, { label: string; latest: string; runs: RunSummary[] }>();
  for (const run of tops) {
    const label = dayLabel(run.updatedAt, new Date(now));
    const day = days.get(label) ?? { label, latest: run.updatedAt, runs: [] };
    day.runs.push(run);
    day.latest = day.latest > run.updatedAt ? day.latest : run.updatedAt;
    days.set(label, day);
  }
  return [...days.values()]
    .sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0))
    .map(({ label, runs }) => ({ label, runs }));
}
