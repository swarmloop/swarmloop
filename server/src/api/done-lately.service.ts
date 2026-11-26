import { Injectable } from '@nestjs/common';
import type { RunsView } from '../contract/api';
import type { DoneLatelyItem } from '../contract/overview-done';
import { AgentCallRepository } from '../history/agent-call.repository';
import { BacklogQueries } from '../pipeline/backlog/backlog-queries';
import { doneItems } from './done-items';
import { RunListRows } from './run-list-rows';

/** The latest finished items for the Overview, with their cost from one read of the agent call log. */
@Injectable()
export class DoneLatelyService {
  constructor(
    private readonly rows: RunListRows,
    private readonly backlogs: BacklogQueries,
    private readonly calls: AgentCallRepository,
  ) {}

  async items(): Promise<DoneLatelyItem[]> {
    return this.fromView((await this.rows.read()).view);
  }

  /** The items worked out from a view the caller already read. */
  async fromView(view: RunsView): Promise<DoneLatelyItem[]> {
    const picked = doneItems(view.runs, await this.backlogs.acceptedMilestones());
    const keysOf = (item: DoneLatelyItem): string[] => {
      const own = new Set(item.runKeys);
      const subtasks = view.runs.flatMap((run) => (run.parentKey && own.has(run.parentKey) ? run.key : []));
      return [...own, ...subtasks];
    };
    const spend = await this.calls.spendOfRuns([...new Set(picked.flatMap(keysOf))]);
    return picked.map((item) => ({
      ...item,
      usd: keysOf(item).reduce((sum, key) => sum + (spend.get(key) ?? 0), 0),
    }));
  }
}
