import { agentFor } from '../config/agents';
import type { StoredAgents } from '../contract/api';
import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, In, Repository } from 'typeorm';
import { AppConfig } from '../config/env';
import { randomUUID } from 'crypto';
import { Clock } from '../core/clock';
import { SERVER_INSTANCE } from '../core/server-instance';
import { adoptRow, changedColumns, readValue } from './run-read';
import { claimedColumns, storedState, stateColumns, titleColumns, unseenStartWait } from './run-state';
import { claimedRow, waitingRow } from './run-new-rows';
import { conditionalUpdate } from './conditional-write';
import { KeyedQueue } from './keyed-queue';
import { RunOpenItems } from './run-open-items';
import { transaction } from './transaction';
import { pidAlive } from './pid-alive';
import { durationByRun } from './run-durations';
import type { RunStateChange, StartWaitColumns } from './run-state';
import { LiveHub } from '../live/live.hub';
import { SwarmloopError } from '../core/swarmloop-error';
import { parseSubtasks, SUBTASKS_KIND } from '../contract/subtask';
import { DocumentRepository } from './document.repository';
import { VisitRepository } from './visit.repository';
import { root } from './run-paths';
import { RunWaitEntity } from './run-wait.entity';
import { removeStoredFiles } from './stored-files';
import {
  RunEntity,
  StepStatEntity,
  CheckCommandEntity,
  ResourceSampleEntity,
  AgentExchangeEntity,
  HttpCallEntity,
  DocumentEntity,
  LoopEventEntity,
  FlowEntity,
  PasteEntity,
  CommandEntity,
} from './entities';

/** SQLite refuses to write on a read that another connection wrote under: the try lost, as a conditional update does. */
const SNAPSHOT_BUSY = 'database is locked';
const LOST = Symbol('lost');

@Injectable()
export class RunRepository {
  private readonly changes = new KeyedQueue();

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    @InjectRepository(RunEntity) private readonly runs: Repository<RunEntity>,
    @InjectRepository(StepStatEntity) private readonly stepStats: Repository<StepStatEntity>,
    @InjectRepository(ResourceSampleEntity) private readonly samples: Repository<ResourceSampleEntity>,
    @InjectRepository(AgentExchangeEntity) private readonly exchanges: Repository<AgentExchangeEntity>,
    @InjectRepository(HttpCallEntity) private readonly httpCalls: Repository<HttpCallEntity>,
    @InjectRepository(DocumentEntity) private readonly documents: Repository<DocumentEntity>,
    @InjectRepository(LoopEventEntity) private readonly loops: Repository<LoopEventEntity>,
    @InjectRepository(FlowEntity) private readonly flows: Repository<FlowEntity>,
    @InjectRepository(PasteEntity) private readonly pastes: Repository<PasteEntity>,
    @InjectRepository(CommandEntity) private readonly commands: Repository<CommandEntity>,
    @InjectRepository(CheckCommandEntity) private readonly checkCommands: Repository<CheckCommandEntity>,
    @InjectRepository(RunWaitEntity) private readonly waits: Repository<RunWaitEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly openItems: RunOpenItems,
    private readonly documentRepository: DocumentRepository,
    private readonly visitRepository: VisitRepository,
    @Optional() private readonly live?: LiveHub,
  ) {}

  async findRun(key: string): Promise<RunEntity | null> {
    return this.runs.findOne({ where: { key } });
  }

  async findById(id: number): Promise<RunEntity | null> {
    return this.runs.findOne({ where: { id } });
  }

  /** The subtasks of a run, in the task order of its `subtasks` document. */
  async children(run: RunEntity): Promise<RunEntity[]> {
    const rows = await this.runs.find({ where: { parentRunId: run.id } });
    const order = parseSubtasks(await this.documentRepository.latestBody(run.key, SUBTASKS_KIND)).map(
      (task) => task.id,
    );
    const place = (row: RunEntity) => {
      const index = order.indexOf(row.taskId ?? '');
      return index === -1 ? order.length : index;
    };
    return rows.sort((a, b) => place(a) - place(b) || a.id - b.id);
  }

  /** The key, revision and state of every subtask of a run: what a pass of the parent sees. */
  async subtaskFingerprint(parent: RunEntity): Promise<string> {
    const children = await this.children(parent);
    const seen = children.map((child) => [child.key, child.revision, storedState(child).state]);
    return JSON.stringify(seen.sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  }

  /** Stores the fingerprint without a run change: no revision, no update time, no notice. */
  async recordSubtaskFingerprint(parent: RunEntity, subtaskFingerprint: string): Promise<void> {
    await this.runs.update({ id: parent.id }, { subtaskFingerprint });
  }

  /** Merges the base tips of some repositories into the run's own, without a run change. A key with no run changes nothing. */
  async recordBaseTips(key: string, tips: Record<string, string>): Promise<void> {
    await this.changes.run(key, () =>
      this.write(
        key,
        (run) => {
          run.baseTips = { ...run.baseTips, ...tips };
        },
        true,
      ),
    );
  }

  /**
   * The one door for a change to a run's row. `apply` reads the row it is given and only sets columns on it: it
   * starts nothing and writes nothing else, and it may run again. The changed columns are written on the condition
   * that each still holds the value `apply` read; a write that lost to another writer applies again on the row as
   * it is now. Calls for one run go one at a time. Returns the stored row. Nothing is written when nothing changed.
   */
  change(key: string, apply: (run: RunEntity) => void): Promise<RunEntity> {
    return this.changes.run(key, async () => (await this.write(key, apply, false)) as RunEntity);
  }

  /**
   * The write of `change`, with the state its open items give. Each try is one transaction: the read, the conditional
   * update and the state. A try that lost, or whose read another process wrote under, goes again on the row as it is
   * now. Quiet: no update time and no notice, and a run that is gone changes nothing.
   */
  private async write(key: string, apply: (run: RunEntity) => void, quiet: boolean): Promise<RunEntity | null> {
    const seen = { columns: [] as string[] };
    for (let tries = 0; tries < 3; tries++) {
      const done = await this.attempt(key, apply, quiet, seen).catch((error: unknown): typeof LOST => {
        if (String(error).includes(SNAPSHOT_BUSY)) return LOST;
        throw error;
      });
      if (done === LOST) continue;
      if (done?.changed && !quiet) this.live?.changed(key);
      return done?.run ?? null;
    }
    throw new SwarmloopError(
      `${key}: ${seen.columns.join(', ')} changed under every one of three tries; nothing was written`,
    );
  }

  private attempt(
    key: string,
    apply: (run: RunEntity) => void,
    quiet: boolean,
    seen: { columns: string[] },
  ): Promise<{ run: RunEntity; changed: boolean } | typeof LOST | null> {
    return transaction(this.dataSource, async (manager) => {
      const gone = () => new SwarmloopError(`${key}: the run is gone; nothing was written`);
      const runs = manager.getRepository(RunEntity);
      const run = await runs.findOne({ where: { key } });
      if (!run) {
        if (quiet) return null;
        throw gone();
      }
      apply(run);
      const changed = changedColumns(run);
      seen.columns = Object.keys(changed);
      const extra = quiet ? {} : { updatedAt: this.clock.iso() };
      if (
        seen.columns.length > 0 &&
        !(await conditionalUpdate(runs, run.id, changed, (column) => readValue(run, column), extra))
      )
        return LOST;
      const held = await this.openItems.hold(manager, { id: run.id });
      if (seen.columns.length === 0 && !held) return { run, changed: false };
      const stored = await runs.findOneBy({ id: run.id });
      if (!stored) {
        if (quiet) return null;
        throw gone();
      }
      adoptRow(run, stored);
      return { run, changed: true };
    });
  }

  /** Stores the title in a single statement and tells the dashboard. */
  async recordTitle(run: RunEntity, title: string): Promise<void> {
    await this.runs.update({ id: run.id }, titleColumns(title));
    this.live?.changed(run.key);
  }

  async findSubtask(parent: RunEntity, taskId: string): Promise<RunEntity | null> {
    return this.runs.findOne({ where: { parentRunId: parent.id, taskId } });
  }

  /** Depth is one: a subtask never splits into subtasks of its own. */
  assertSplittable(run: RunEntity): void {
    if (run.parentRunId !== null) {
      throw new SwarmloopError('a subtask cannot be split');
    }
  }

  /** A waiting run row that is not stored yet. */
  newWaitingRun(
    key: string,
    targetPath: string | null,
    startedBy: string | null = null,
    agents: StoredAgents | null = null,
  ): RunEntity {
    return waitingRow((row) => this.runs.create(row), this.config, this.clock, key, targetPath, startedBy, agents);
  }

  /** The waiting row of a subtask, linked to its parent in the same write that creates it. It belongs to the person of its parent. */
  async openSubtask(
    key: string,
    parentRunId: number,
    taskId: string,
    startedBy: string | null = null,
    agents: StoredAgents | null = null,
  ): Promise<RunEntity> {
    const run = Object.assign(this.newWaitingRun(key, null, startedBy, agents), { parentRunId, taskId });
    run.runtime = agentFor(this.config.env, run, 'implement').runtime;
    return this.insertRun(run);
  }

  /** The run row of a split run. The command door may have made it already: then it is marked split. */
  async openSplit(key: string): Promise<RunEntity> {
    if (await this.findRun(key)) {
      return this.change(key, (run) => {
        run.split = true;
      });
    }
    return this.insertRun(Object.assign(this.newWaitingRun(key, null), { split: true }));
  }

  async openWaiting(key: string, targetPath: string): Promise<RunEntity> {
    return this.insertRun(this.newWaitingRun(key, targetPath));
  }

  async begin(key: string, step: string): Promise<RunEntity> {
    return this.claim(key, step);
  }

  /** Takes the run for a step with one conditional write. The loser of a race gets `already running`. */
  async claim(key: string, step: string): Promise<RunEntity> {
    for (let tries = 0; tries < 2; tries++) {
      const existing = await this.findRun(key);
      if (!existing) {
        return this.insertClaimed(key, step);
      }
      if (this.held(existing)) {
        break;
      }
      const runtime = agentFor(this.config.env, existing, 'implement').runtime;
      const now = this.clock.iso();
      const claimed = await this.runs
        .createQueryBuilder()
        .update(RunEntity)
        .set({
          ...claimedColumns(step, randomUUID()),
          runtime,
          stepStartedAt: now,
          updatedAt: now,
          revision: () => 'revision + 1',
        })
        .where('key = :key AND revision = :revision', { key, revision: existing.revision })
        .execute();
      if (claimed.affected) {
        // Only the winner touches the live spend; a loser must not disturb the run it lost to.
        this.live?.clearSpend(key);
        const claimedRun = await this.runs.findOneByOrFail({ key });
        this.notify(key);
        return claimedRun;
      }
    }
    throw new SwarmloopError(`${key} is already running`);
  }

  /**
   * Gives the run back after a hold that stored no visit, if it is still the holder's.
   * Another writer that took the run in between keeps it. Either way the row in the database is returned.
   */
  async release(run: RunEntity, change: RunStateChange & { stepStartedAt?: string | null }): Promise<RunEntity> {
    const { stepStartedAt, ...state } = change;
    const attempt = run.activeAttempt;
    Object.assign(
      run,
      stateColumns(run, { ...state, activeAttempt: null }),
      stepStartedAt === undefined ? {} : { stepStartedAt },
    );
    await transaction(this.dataSource, async (manager) => {
      await manager
        .getRepository(RunEntity)
        .createQueryBuilder()
        .update()
        .set({ ...changedColumns(run), updatedAt: this.clock.iso(), revision: () => 'revision + 1' })
        .where('id = :id AND active_attempt IS :attempt', { id: run.id, attempt })
        .execute();
      await this.openItems.hold(manager, { id: run.id });
    });
    adoptRow(run, await this.runs.findOneByOrFail({ id: run.id }));
    this.notify(run.key);
    return run;
  }

  private async insertClaimed(key: string, step: string): Promise<RunEntity> {
    const created = claimedRow((row) => this.runs.create(row), this.config, this.clock, key, step, randomUUID());
    try {
      return await this.insertRun(created);
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed: runs.key')) {
        throw new SwarmloopError(`${key} is already running`);
      }
      throw error;
    }
  }

  /** Stores a run copy that is not stored yet, makes it the stored row and tells the dashboard. A run row is created only here and in `CommandRepository.accept`, which creates the row of a command for a run that does not exist yet, inside its own transaction. */
  async insertRun(run: RunEntity): Promise<RunEntity> {
    await this.runs.save(run);
    adoptRow(run, await this.runs.findOneByOrFail({ id: run.id }));
    this.live?.changed(run.key);
    return run;
  }

  /** Tells the dashboard about a write that bypassed `change`. */
  notify(key: string): void {
    this.live?.changed(key);
  }

  /**
   * Stores what an agent start of a running run waits for. It writes only while the row still reads `running` and
   * only when the columns differ, and leaves the revision: the wait is no change of the run. Tells the dashboard when written.
   */
  async recordStartWait(
    seen: Pick<RunEntity, 'id' | 'key'> & StartWaitColumns,
    columns: StartWaitColumns,
  ): Promise<boolean> {
    const unseen = unseenStartWait(seen, columns);
    if (Object.keys(unseen).length === 0) return false;
    const written = await this.runs.update({ id: seen.id, status: 'running' }, unseen);
    if (!written.affected) return false;
    this.live?.changed(seen.key);
    return true;
  }

  /** Raises the generation by one in a single statement, so a restart cannot count the same command twice. */
  async bumpGeneration(key: string): Promise<void> {
    await this.runs.increment({ key }, 'generation', 1);
    this.live?.changed(key);
  }

  /** Marks the worktrees of a run as removed by retention, in a single statement. */
  async markWorkspaceRemoved(key: string): Promise<void> {
    await this.runs.update({ key }, { workspace: 'removed' });
    this.live?.changed(key);
  }

  async clearWorkspaceRemoved(key: string): Promise<void> {
    await this.runs.update({ key }, { workspace: null });
    this.live?.changed(key);
  }

  async listRuns(where?: FindOptionsWhere<RunEntity>): Promise<RunEntity[]> {
    return this.runs.find({ where, order: { createdAt: 'DESC', id: 'DESC' } });
  }

  /** Drop this run's rows and the files swarmloop stored for it. The worktrees, agent state and /tmp folders go through RunFolders. */
  async remove(run: RunEntity): Promise<void> {
    const keys = (await this.listRuns()).map((row) => row.key);
    await removeStoredFiles(root(this.config), run.key, keys);
    const stats = await this.stepStats.find({ where: { runId: run.id } });
    const statIds = stats.map((stat) => stat.id);
    if (statIds.length > 0) {
      await this.samples.delete({ stepStatId: In(statIds) });
      await this.exchanges.delete({ stepStatId: In(statIds) });
    }
    await this.httpCalls.delete({ runId: run.id });
    await this.stepStats.delete({ runId: run.id });
    await this.documents.delete({ runId: run.id });
    await this.loops.delete({ runId: run.id });
    await this.flows.delete({ runId: run.id });
    await this.pastes.delete({ runKey: run.key });
    await this.commands.delete({ runId: run.id });
    await this.checkCommands.delete({ runId: run.id });
    await this.waits.delete({ runId: run.id });
    await this.runs.delete({ id: run.id });
    this.live?.clearSpend(run.key);
    this.live?.changed(run.key);
  }

  held(run: RunEntity): boolean {
    return (
      run.status === 'running' &&
      (pidAlive(run.ownerPid) || (run.ownerInstance === SERVER_INSTANCE && run.activeAttempt !== null))
    );
  }

  /** The active time of every run, or only of the runs with these ids. */
  async durationByRun(runIds?: number[]): Promise<Map<number, number>> {
    return durationByRun(this.stepStats, this.visitRepository, runIds);
  }
}
