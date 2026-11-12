import { agentFor } from '../config/agents';
import type { StoredAgents } from '../contract/api';
import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AppConfig } from '../config/env';
import { randomUUID } from 'crypto';
import { Clock } from '../core/clock';
import { SERVER_INSTANCE } from '../core/server-instance';
import { claimedColumns, deriveState, stateColumns } from './run-state';
import type { RunStateChange } from './run-state';
import { LiveHub } from '../live/live.hub';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { SwarmloopError } from '../core/swarmloop-error';
import { sessionHome } from '../history/session-group';
import { parseSubtasks, SUBTASKS_KIND } from '../contract/subtask';
import { REVIEW_STEPS, STEPS } from '../contract/steps';
import { activeDurationMs, toDurationParts } from './active-duration';
import { DocumentRepository } from './document.repository';
import { VisitRepository } from './visit.repository';
import { removeTree, root } from './run-paths';
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

@Injectable()
export class RunRepository {
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
    const seen = children.map((child) => [child.key, child.revision, deriveState(child).state]);
    return JSON.stringify(seen.sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  }

  /** Stores the fingerprint without a run change: no revision, no update time, no notice. */
  async recordSubtaskFingerprint(parent: RunEntity, subtaskFingerprint: string): Promise<void> {
    await this.runs.update({ id: parent.id }, { subtaskFingerprint });
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
    const env = this.config.env;
    const now = this.clock.iso();
    const created = this.runs.create({
      key,
      ...stateColumns({ currentStep: 'requirements', ownerInstance: null, activeAttempt: null }, { status: 'waiting' }),
      runtime: agentFor(env, { agents }, 'implement').runtime,
      requirementsVia: env.REQUIREMENTS_VIA,
      issueTracker: env.ISSUE_TRACKER,
      codeHost: '',
      attemptsReview: 0,
      attemptsQa: 0,
      attemptsPipeline: 0,
      attemptsChecks: 0,
      agentCalls: 0,
      spentUsd: 0,
      agents,
      targetPath,
      projects: null,
      prompt: null,
      createdAt: now,
      updatedAt: now,
      stepStartedAt: null,
      parentRunId: null,
      taskId: null,
      split: false,
      startedBy,
    });
    return created;
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
    return this.saveRun(run);
  }

  /** The run row of a split run. The command door may have made it already: then it is marked split. */
  async openSplit(key: string): Promise<RunEntity> {
    const run = (await this.findRun(key)) ?? this.newWaitingRun(key, null);
    run.split = true;
    return this.saveRun(run);
  }

  async openWaiting(key: string, targetPath: string): Promise<RunEntity> {
    return this.saveRun(this.newWaitingRun(key, targetPath));
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
        // Only the winner touches the live spend and the resume note; a loser must not disturb the run it lost to.
        this.live?.clearSpend(key);
        if (existing.runtime !== runtime) {
          await this.documentRepository.putDocument(existing, 'shell_resume', 'clear\n');
        }
        const claimedRun = await this.runs.findOneByOrFail({ key });
        this.notify(key);
        return claimedRun;
      }
    }
    throw new SwarmloopError(`${key} is already running`);
  }

  /**
   * Gives the run back after a hold that stored no visit (a chat, a shell lock), if it is still the holder's.
   * Another writer that took the run in between keeps it. Either way the row in the database is returned.
   */
  async release(run: RunEntity, change: RunStateChange & { stepStartedAt?: string | null }): Promise<RunEntity> {
    const { stepStartedAt, ...state } = change;
    await this.runs
      .createQueryBuilder()
      .update(RunEntity)
      .set({
        ...stateColumns(run, { ...state, activeAttempt: null }),
        ...(stepStartedAt === undefined ? {} : { stepStartedAt }),
        updatedAt: this.clock.iso(),
        revision: () => 'revision + 1',
      })
      .where('id = :id AND active_attempt IS :attempt', { id: run.id, attempt: run.activeAttempt })
      .execute();
    const released = await this.runs.findOneByOrFail({ id: run.id });
    this.notify(run.key);
    return released;
  }

  private async insertClaimed(key: string, step: string): Promise<RunEntity> {
    const env = this.config.env;
    const now = this.clock.iso();
    const created = this.runs.create({
      key,
      ...claimedColumns(step, randomUUID()),
      runtime: agentFor(env, null, 'implement').runtime,
      requirementsVia: env.REQUIREMENTS_VIA,
      issueTracker: env.ISSUE_TRACKER,
      codeHost: '',
      attemptsReview: 0,
      attemptsQa: 0,
      attemptsPipeline: 0,
      attemptsChecks: 0,
      agentCalls: 0,
      spentUsd: 0,
      targetPath: null,
      projects: null,
      revision: 0,
      generation: 0,
      prompt: null,
      createdAt: now,
      updatedAt: now,
      stepStartedAt: now,
    });
    try {
      return await this.saveRun(created);
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed: runs.key')) {
        throw new SwarmloopError(`${key} is already running`);
      }
      throw error;
    }
  }

  /** Tells the dashboard about a write that bypassed `saveRun`. */
  notify(key: string): void {
    this.live?.changed(key);
  }

  async saveRun(run: RunEntity): Promise<RunEntity> {
    run.updatedAt = this.clock.iso();
    const saved = await this.runs.save(run);
    this.live?.changed(saved.key);
    return saved;
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

  async listRuns(): Promise<RunEntity[]> {
    return this.runs.find({ order: { createdAt: 'DESC', id: 'DESC' } });
  }

  /** Drop this run's rows and the files swarmloop stored for it. Worktrees stay with prepare. */
  async remove(run: RunEntity): Promise<void> {
    const keys = (await this.listRuns()).map((row) => row.key);
    removeStoredFiles(root(this.config), run.key, keys);
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
    const stats = await this.stepStats.find({
      ...(runIds ? { where: { runId: In(runIds) } } : {}),
      select: {
        id: true,
        runId: true,
        step: true,
        durationMs: true,
        stepStartedAt: true,
        startedAt: true,
        finishedAt: true,
      },
      order: { id: 'ASC' },
    });
    const reports = await this.visitRepository.codeReviewReportMs();
    const byRun = new Map<number, StepStatEntity[]>();
    for (const stat of stats) {
      const rows = byRun.get(stat.runId) ?? [];
      rows.push(stat);
      byRun.set(stat.runId, rows);
    }
    const totals = new Map<number, number>();
    for (const [runId, rows] of byRun) {
      totals.set(runId, activeDurationMs(toDurationParts(rows, reports)));
    }
    return totals;
  }
}

const DATA_STEPS = [...STEPS, ...REVIEW_STEPS, 'code-review-report', 'chat'];

/** This id's step files. The longer step name wins, a later `<key>--N` session stays, and the shared data names stay. */
function ownedDataFile(key: string, name: string, keys: readonly string[]): boolean {
  if (sharedDataName(name) || !name.startsWith(`${key}-`) || name.startsWith(`${key}--`)) {
    return false;
  }
  return dataFileOwner(name, keys) === key;
}

function dataFileOwner(name: string, keys: readonly string[]): string | null {
  let best: { key: string; step: string; exact: boolean } | null = null;
  for (const candidate of keys) {
    const match = dataFileMatch(candidate, name);
    if (match && (!best || betterMatch(match, best))) {
      best = match;
    }
  }
  return best?.key ?? null;
}

function betterMatch(
  next: { key: string; step: string; exact: boolean },
  best: { key: string; step: string; exact: boolean },
): boolean {
  if (next.exact !== best.exact) {
    return next.exact;
  }
  if (next.step.length !== best.step.length) {
    return next.step.length > best.step.length;
  }
  return next.key.length > best.key.length;
}

function dataFileMatch(key: string, name: string): { key: string; step: string; exact: boolean } | null {
  if (!name.startsWith(`${key}-`) || name.startsWith(`${key}--`)) {
    return null;
  }
  const rest = name.slice(key.length + 1);
  const body = rest.endsWith('-output.txt')
    ? rest.slice(0, -'-output.txt'.length)
    : rest.endsWith('-launches.txt')
      ? rest.slice(0, -'-launches.txt'.length)
      : rest.endsWith('-session.json')
        ? rest.slice(0, -'-session.json'.length)
        : null;
  if (body === null) {
    return null;
  }
  const step = rest.endsWith('-session.json') ? sessionMatch(body) : stepMatch(body);
  return step ? { key, ...step } : null;
}

function stepMatch(body: string): { step: string; exact: boolean } | null {
  let best: { step: string; exact: boolean } | null = null;
  for (const step of DATA_STEPS) {
    const exact = body === step;
    if (!exact && !body.startsWith(`${step}-`)) {
      continue;
    }
    if (!best || (exact !== best.exact ? exact : step.length > best.step.length)) {
      best = { step, exact };
    }
  }
  return best;
}

function sessionMatch(body: string): { step: string; exact: boolean } | null {
  return DATA_STEPS.some((step) => sessionHome(step) === body) ? { step: body, exact: true } : null;
}

function sharedDataName(name: string): boolean {
  return name === 'agent-state' || name === 'swarmloop-empty-env' || name.startsWith('price-cache-');
}

function removeStoredFiles(root: string, key: string, keys: readonly string[]): void {
  const data = join(root, 'data');
  if (existsSync(data)) {
    for (const name of readdirSync(data)) {
      if (ownedDataFile(key, name, keys)) {
        removeTree(join(data, name));
      }
    }
  }
  removeTree(join(root, 'data', 'agent-state', key));
  removeTree(join(root, 'runs', key));
}

function pidAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
