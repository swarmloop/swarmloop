import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { LiveHub } from '../live/live.hub';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { SwarmloopError } from '../core/swarmloop-error';
import { sessionHome } from '../history/session-group';
import { REVIEW_STEPS, STEPS } from '../contract/steps';
import { activeDurationMs, toDurationParts } from './active-duration';
import { DocumentRepository } from './document.repository';
import { VisitRepository } from './visit.repository';
import { root } from './run-paths';
import {
  RunEntity,
  StepStatEntity,
  ResourceSampleEntity,
  AgentExchangeEntity,
  HttpCallEntity,
  DocumentEntity,
  LoopEventEntity,
  FlowEntity,
  PasteEntity,
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
    private readonly documentRepository: DocumentRepository,
    private readonly visitRepository: VisitRepository,
    @Optional() private readonly live?: LiveHub,
  ) {}

  async findRun(key: string): Promise<RunEntity | null> {
    return this.runs.findOne({ where: { key } });
  }

  async openWaiting(key: string, targetPath: string): Promise<RunEntity> {
    const env = this.config.env;
    const now = this.clock.iso();
    const created = this.runs.create({
      key,
      status: 'waiting',
      currentStep: 'requirements',
      runtime: env.RUNTIME,
      requirementsVia: env.REQUIREMENTS_VIA,
      issueTracker: env.ISSUE_TRACKER,
      codeHost: '',
      attemptsReview: 0,
      attemptsQa: 0,
      attemptsPipeline: 0,
      agentCalls: 0,
      spentUsd: 0,
      targetPath,
      projects: null,
      ownerPid: null,
      prompt: null,
      createdAt: now,
      updatedAt: now,
      stepStartedAt: null,
    });
    return this.saveRun(created);
  }

  async begin(key: string, step: string): Promise<RunEntity> {
    const existing = await this.findRun(key);
    const now = this.clock.iso();
    if (!existing) {
      const env = this.config.env;
      const created = this.runs.create({
        key,
        status: 'running',
        currentStep: step,
        runtime: env.RUNTIME,
        requirementsVia: env.REQUIREMENTS_VIA,
        issueTracker: env.ISSUE_TRACKER,
        codeHost: '',
        attemptsReview: 0,
        attemptsQa: 0,
        attemptsPipeline: 0,
        agentCalls: 0,
        spentUsd: 0,
        targetPath: null,
        projects: null,
        ownerPid: process.pid,
        prompt: null,
        createdAt: now,
        updatedAt: now,
        stepStartedAt: now,
      });
      return this.saveRun(created);
    }
    if (this.held(existing)) {
      throw new SwarmloopError(`${key} is already running`);
    }
    this.live?.clearSpend(key);
    const runtime = this.config.env.RUNTIME;
    if (existing.runtime !== runtime) {
      existing.runtime = runtime;
      await this.documentRepository.putDocument(existing, 'shell_resume', 'clear\n');
    }
    existing.status = 'running';
    existing.currentStep = step;
    existing.ownerPid = process.pid;
    existing.stepStartedAt = now;
    return this.saveRun(existing);
  }

  async saveRun(run: RunEntity): Promise<RunEntity> {
    run.updatedAt = this.clock.iso();
    const saved = await this.runs.save(run);
    this.live?.changed(saved.key);
    return saved;
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
    await this.runs.delete({ id: run.id });
    this.live?.clearSpend(run.key);
    this.live?.changed(run.key);
  }

  held(run: RunEntity): boolean {
    return run.status === 'running' && pidAlive(run.ownerPid);
  }

  async durationByRun(): Promise<Map<number, number>> {
    const stats = await this.stepStats.find({
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

function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
