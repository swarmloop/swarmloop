import type { FlowView } from '@contract/api';
import type { LiveRunUsage } from '@contract/live';

/**
 * The run page after a usage entry. The entry of the page's own run replaces the tokens, cost and peaks of its
 * metrics, and its epic total when it has one; the entry of a task's run replaces that task's cost. Any other
 * entry leaves the page as it is.
 */
export function withUsage(flow: FlowView, entry: LiveRunUsage): FlowView {
  if (entry.key === flow.key) {
    const { tokens, usd, cpuPeak, memPeak } = entry;
    return {
      ...flow,
      metrics: { ...flow.metrics, tokens, usd, cpuPeak, memPeak },
      ...(entry.epic ? { epic: entry.epic } : {}),
    };
  }
  if (!flow.tasks?.some((task) => task.run?.key === entry.key)) {
    return flow;
  }
  return {
    ...flow,
    tasks: flow.tasks.map((task) =>
      task.run?.key === entry.key ? { ...task, run: { ...task.run, usd: entry.usd } } : task,
    ),
  };
}
