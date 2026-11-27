import { Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { In } from 'typeorm';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import type { RunEta } from '../contract/eta';
import type { EtaTable, LiveRun } from '../eta/eta.types';
import type { RunBacklog } from '../contract/backlog';
import type { RunsView } from '../contract/api';
import type { Subtask } from '../contract/subtask';
import { AgentCallRepository } from '../history/agent-call.repository';
import { BacklogRepository } from '../history/backlog.repository';
import { CommandRepository } from '../history/command.repository';
import { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import { FlowRepository } from '../history/flow.repository';
import { RunRepository } from '../history/run.repository';
import { runOver } from '../history/run-over';
import { VisitRepository } from '../history/visit.repository';
import type { RunWaitEntity } from '../history/run-wait.entity';
import { RunWaitLog } from '../history/run-wait.log';
import { LiveHub } from '../live/live.hub';
import { PipelineService } from '../pipeline/pipeline.service';
import { epicTotal } from '../steps/shared/epic-total';
import { runName } from './run-view/flow';
import { listPlans, listStates } from './run-view/list-state';
import { mergeWaits } from './run-view/merge-wait';
import { ownStates, type OwnState } from './run-view/own-state';
import { requirementBodies, viewTitle } from './run-view/run-title';
import { childrenByParent, listExtras } from './run-view/status';
import { EtaSummary } from './eta-summary';
import { relaunchSteps } from './run-view/relaunch';
import { liveRunOf, runViewEta } from './run-view/run-eta';

/** What is read from the database for one run, and the claim its state was worked out with. */
interface KeptRun {
  run: RunEntity;
  durationMs: number;
  requirements: string | undefined;
  /** The tasks of its latest plan; only a run that can hold a plan has them. */
  plan: Subtask[] | undefined;
  own: OwnState;
  /** The stretches the run waited in; read only while the run has not ended. */
  waits: RunWaitEntity[];
  /** The steps the run's open relaunch still has to run; read only while the run has not ended. */
  relaunch: string[] | undefined;
  label: RunBacklog | undefined;
  /** What the run's rows in the log cost; read again on each list read only while the run can still gain rows. */
  usd: number;
  claimed: boolean;
}

/** Newest first, like `listRuns`. */
function newestFirst(a: RunEntity, b: RunEntity): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return b.id - a.id;
}

/**
 * The run list, kept in memory: one row of database facts per run, built on the first read. A change of a run
 * re-reads only that run (and its parent, for a subtask); each read puts the rows together with the parts that
 * cross runs or move with time, so the list reads as a fresh build would.
 */
@Injectable()
export class RunListRows implements OnModuleDestroy {
  private readonly kept = new Map<string, KeptRun>();
  private readonly dirty = new Set<string>();
  private built = false;
  private tail: Promise<unknown> = Promise.resolve();
  private stop: (() => void) | undefined;

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly commands: CommandRepository,
    private readonly backlogs: BacklogRepository,
    private readonly pipeline: PipelineService,
    private readonly clock: Clock,
    private readonly etaSummary: EtaSummary,
    private readonly waitLog: RunWaitLog,
    private readonly flows: FlowRepository,
    private readonly visits: VisitRepository,
    private readonly config: AppConfig,
    private readonly calls: AgentCallRepository,
    @Optional() private readonly live?: LiveHub,
  ) {}

  onModuleDestroy(): void {
    this.stop?.();
  }

  /** The list, and how many runs were read again to make it. Reads run one after another. */
  read(): Promise<{ view: RunsView; recomputed: number }> {
    const next = this.tail.then(async () => {
      await this.waitLog.settled();
      const table = await this.etaSummary.table();
      const recomputed = await this.refresh();
      await this.refreshSpend();
      return { view: this.assemble(table), recomputed };
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async refresh(): Promise<number> {
    if (!this.built) {
      // Changes are heard from the first read on: that read builds every row, so nothing earlier matters.
      this.stop ??= this.live?.onChanged((key) => this.dirty.add(key));
      this.dirty.clear();
      const everyone = await this.runs.listRuns();
      this.kept.clear();
      await this.load(everyone, true);
      this.built = true;
      return everyone.length;
    }
    this.markMoved();
    const taken = [...this.dirty];
    this.dirty.clear();
    if (taken.length === 0) return 0;
    try {
      return await this.reread(taken);
    } catch (error) {
      for (const key of taken) this.dirty.add(key);
      throw error;
    }
  }

  /**
   * A run that can still run gains rows without a change of the run, so its cost is read again here. The cost of an ended run was read with the run, by the change that ended it.
   */
  private async refreshSpend(): Promise<void> {
    const open = [...this.kept.values()].filter((entry) => !runOver(entry.run));
    const sums = await this.calls.spendOfRuns(open.map((entry) => entry.run.key));
    for (const entry of open) entry.usd = sums.get(entry.run.key) ?? 0;
  }

  /** A run the pipeline now holds is not the run its state was read for. */
  private markMoved(): void {
    for (const [key, entry] of this.kept) {
      if (entry.claimed !== this.pipeline.claimed(key)) this.dirty.add(key);
    }
  }

  private async reread(keys: string[]): Promise<number> {
    const found = await this.runs.listRuns({ key: In(keys) });
    const foundKeys = new Set(found.map((run) => run.key));
    const parentIds = new Set<number>();
    for (const key of keys) {
      for (const run of [this.kept.get(key)?.run, found.find((row) => row.key === key)]) {
        if (typeof run?.parentRunId === 'number') parentIds.add(run.parentRunId);
      }
    }
    const parents = parentIds.size === 0 ? [] : await this.runs.listRuns({ id: In([...parentIds]) });
    const fresh = [...found, ...parents.filter((run) => !foundKeys.has(run.key))];
    for (const key of keys) {
      if (!foundKeys.has(key)) this.kept.delete(key);
    }
    await this.load(fresh, false);
    return fresh.length;
  }

  /** Reads what the database holds of these runs, with today's functions, and keeps it. */
  private async load(runs: RunEntity[], every: boolean): Promise<void> {
    if (runs.length === 0) return;
    const current = new Map([...this.kept].map(([key, entry]) => [key, entry.run]));
    for (const run of runs) current.set(run.key, run);
    const childrenOf = childrenByParent([...current.values()]);
    const claimed = new Map(runs.map((run) => [run.key, this.pipeline.claimed(run.key)]));
    const durations = await this.runs.durationByRun(every ? undefined : runs.map((run) => run.id));
    const plans = await listPlans(this.documents, runs, childrenOf);
    const requirements = await requirementBodies(this.documents, runs);
    const states = await ownStates({ commands: this.commands }, runs, (key) => claimed.get(key) ?? false);
    const labels = await this.backlogs.labelsFor(runs.map((run) => run.key));
    const unended = runs.filter((run) => run.status !== 'done').map((run) => run.id);
    const waits = await this.waitLog.waitsOf(unended);
    const relaunches = await relaunchSteps(this.flows, this.visits, unended);
    const costs = await this.calls.spendOfRuns(runs.map((run) => run.key));
    for (const run of runs) {
      this.kept.set(run.key, {
        run,
        durationMs: durations.get(run.id) ?? 0,
        requirements: requirements.get(run.id),
        plan: plans.get(run.key),
        own: states.get(run.key) as OwnState,
        waits: waits.get(run.id) ?? [],
        relaunch: relaunches.get(run.id),
        label: labels.get(run.key),
        usd: costs.get(run.key) ?? 0,
        claimed: claimed.get(run.key) ?? false,
      });
    }
  }

  /** Puts the rows together from the kept facts, in memory. */
  private assemble(table: EtaTable): RunsView {
    const entries = [...this.kept.values()].sort((a, b) => newestFirst(a.run, b.run));
    const runs = entries.map((entry) => entry.run);
    const keys = new Map(runs.map((run) => [run.id, run.key]));
    const childrenOf = childrenByParent(runs);
    const plans = new Map<string, Subtask[]>();
    for (const entry of entries) {
      if (entry.plan) plans.set(entry.run.key, entry.plan);
    }
    const waits = mergeWaits(plans, runs, keys);
    const usdOf = (run: RunEntity): number => this.kept.get(run.key)?.usd ?? 0;
    const states = listStates(runs, { keys, childrenOf, plans }, new Map(entries.map((e) => [e.run.key, e.own])));
    return {
      runs: entries.map((entry) => {
        const { run, durationMs, requirements, label } = entry;
        const eta = this.etaOf(entry, childrenOf, table);
        return {
          key: run.key,
          name: runName(run.key, run.prompt),
          title: viewTitle(run, requirements ?? null),
          status: run.status,
          currentStep: run.currentStep,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          stepStartedAt: run.stepStartedAt,
          durationMs,
          usd: usdOf(run),
          ...listExtras(run, keys),
          ...(label ? { backlog: label } : {}),
          ...waits.get(run.key),
          ...states[run.key],
          ...epicTotal(run, childrenOf.get(run.id) ?? [], usdOf, this.clock.now()),
          ...(eta ? { eta } : {}),
        };
      }),
    };
  }

  /** The estimate of a run, from the kept facts of the run and of its tasks' runs; `null` waits for a person. */
  private etaOf(entry: KeptRun, childrenOf: Map<number, RunEntity[]>, table: EtaTable): RunEta | undefined {
    const lives = new Map<string, LiveRun>();
    for (const child of childrenOf.get(entry.run.id) ?? []) {
      const kept = this.kept.get(child.key);
      if (child.taskId && kept) lives.set(child.taskId, liveRunOf(child, kept.own, kept.waits, kept.relaunch));
    }
    const live = liveRunOf(entry.run, entry.own, entry.waits, entry.relaunch);
    return runViewEta(live, entry.plan, lives, table, this.config.env.SUBTASKS_PARALLEL, this.clock.now());
  }
}
