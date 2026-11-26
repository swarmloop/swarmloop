import { Injectable, Optional } from '@nestjs/common';
import { Clock } from '../core/clock';
import { AgentCallRepository } from '../history/agent-call.repository';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { LiveHub } from '../live/live.hub';
import { PipelineService } from '../pipeline/pipeline.service';
import { epicTotal } from '../steps/shared/epic-total';
import type { LiveRunUsage } from '../contract/live';
import { usageFigures } from './run-view/flow';
import { shownRun } from './run-view/own-state';
import { loggedUsage } from './run-queries-spend';
import { spendLookup } from '../steps/shared/run-spend';

/** The spend, tokens and peaks of a run as the usage event carries them, read without building the run page. */
@Injectable()
export class RunUsageReader {
  constructor(
    private readonly runs: RunRepository,
    private readonly visits: VisitRepository,
    private readonly pipeline: PipelineService,
    private readonly clock: Clock,
    private readonly calls: AgentCallRepository,
    @Optional() private readonly live?: LiveHub,
  ) {}

  /** The entry of the run, and of its parent when it is a subtask. A missing run gives none. */
  async entries(key: string): Promise<LiveRunUsage[]> {
    const run = await this.runs.findRun(key);
    if (!run) {
      return [];
    }
    const entries = [await this.entryOf(run)];
    const parent = run.parentRunId === null ? null : await this.runs.findById(run.parentRunId);
    if (parent) {
      entries.push(await this.entryOf(parent));
    }
    return entries;
  }

  private async entryOf(run: RunEntity): Promise<LiveRunUsage> {
    const shown = shownRun(run, (held) => this.pipeline.claimed(held));
    const stats = await this.visits.listStats(run.id);
    const figures = usageFigures(
      stats,
      await loggedUsage(run, this.calls),
      this.live?.peaksOf(run.key) ?? { cpuPeak: 0, memPeak: 0 },
    );
    const children = await this.runs.children(run);
    const usdOf = await spendLookup([run, ...children], this.calls);
    return { key: run.key, ...figures, ...epicTotal(shown, children, usdOf, this.clock.now()) };
  }
}
