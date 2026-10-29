import { existsSync, readdirSync, rmSync } from 'fs';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { join } from 'path';
import { In, Repository } from 'typeorm';
import { readEnv } from '../config/env';
import { LiveHub } from '../live/live.hub';
import { resolveRepoRoot } from '../config/repo-root';
import { SwarmloopError } from '../swarmloop-error';
import { sessionHome } from '../limits/session-group';
import { normalizePhases, PhaseName, PHASES, REVIEW_STEPS, STEPS } from '../pipeline/pipeline-result';
import {
  AgentExchangeEntity,
  CheckoutEntity,
  DenyPathEntity,
  DocumentEntity,
  FlowEntity,
  HttpCallEntity,
  LoopEventEntity,
  PasteEntity,
  ResourceSampleEntity,
  RunEntity,
  StepStatEntity,
} from './entities';
import { activeDurationMs, toDurationParts } from './active-duration';
import { summarizeSamples, VisitDraft } from './visit';

@Injectable()
export class HistoryService {
  constructor(
    private readonly config: ConfigService,
    @InjectRepository(RunEntity) private readonly runs: Repository<RunEntity>,
    @InjectRepository(DocumentEntity) private readonly documents: Repository<DocumentEntity>,
    @InjectRepository(StepStatEntity) private readonly stepStats: Repository<StepStatEntity>,
    @InjectRepository(ResourceSampleEntity) private readonly samples: Repository<ResourceSampleEntity>,
    @InjectRepository(AgentExchangeEntity) private readonly exchanges: Repository<AgentExchangeEntity>,
    @InjectRepository(HttpCallEntity) private readonly httpCalls: Repository<HttpCallEntity>,
    @InjectRepository(CheckoutEntity) private readonly checkouts: Repository<CheckoutEntity>,
    @InjectRepository(DenyPathEntity) private readonly denyPaths: Repository<DenyPathEntity>,
    @InjectRepository(LoopEventEntity) private readonly loops: Repository<LoopEventEntity>,
    @InjectRepository(PasteEntity) private readonly pastes: Repository<PasteEntity>,
    @InjectRepository(FlowEntity) private readonly flows: Repository<FlowEntity>,
    @Optional() private readonly live?: LiveHub,
  ) {}

  root(): string {
    return resolveRepoRoot(readEnv(this.config).SWARMLOOP_ROOT, __dirname);
  }

  runDir(key: string): string {
    return join(this.root(), 'runs', key);
  }

  async tokenTotal(runId: number): Promise<number> {
    const rows: { total: number | string | null }[] = await this.stepStats.query(
      'SELECT SUM(tokens_in + tokens_out) AS total FROM step_stats WHERE run_id = ?',
      [runId],
    );
    return Number(rows[0]?.total) || 0;
  }

  async findRun(key: string): Promise<RunEntity | null> {
    return this.runs.findOne({ where: { key } });
  }

  async openWaiting(key: string, targetPath: string): Promise<RunEntity> {
    const env = readEnv(this.config);
    const now = new Date().toISOString();
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
    const now = new Date().toISOString();
    if (!existing) {
      const env = readEnv(this.config);
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
    const runtime = readEnv(this.config).RUNTIME;
    if (existing.runtime !== runtime) {
      existing.runtime = runtime;
      await this.putDocument(existing, 'shell_resume', 'clear\n');
    }
    existing.status = 'running';
    existing.currentStep = step;
    existing.ownerPid = process.pid;
    existing.stepStartedAt = now;
    return this.saveRun(existing);
  }

  held(run: RunEntity): boolean {
    return run.status === 'running' && pidAlive(run.ownerPid);
  }

  async saveStat(stat: StepStatEntity): Promise<void> {
    await this.stepStats.save(stat);
  }

  async saveRun(run: RunEntity): Promise<RunEntity> {
    run.updatedAt = new Date().toISOString();
    const saved = await this.runs.save(run);
    this.live?.changed(saved.key);
    return saved;
  }

  async listFlows(runId: number): Promise<FlowEntity[]> {
    return this.flows.find({ where: { runId }, order: { id: 'ASC' } });
  }

  /** Append a launch. The first row with a null fromStep is the original selection. */
  async noteFlow(key: string, phases: readonly string[], fromStep: string | null): Promise<void> {
    const selected = normalizePhases(phases);
    let run = await this.findRun(key);
    if (!run) {
      run = await this.begin(key, 'requirements');
      run.status = 'waiting';
      run.ownerPid = null;
      run.stepStartedAt = null;
      run = await this.saveRun(run);
    }
    const existing = await this.listFlows(run.id);
    const recordedFrom = existing.some((row) => row.fromStep === null) ? (fromStep ?? run.currentStep) : fromStep;
    await this.flows.save(
      this.flows.create({
        runId: run.id,
        phases: JSON.stringify(selected),
        fromStep: recordedFrom,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  async activePhases(runId: number): Promise<PhaseName[]> {
    const latest = (await this.listFlows(runId)).at(-1);
    if (!latest) {
      return [...PHASES];
    }
    try {
      const parsed = JSON.parse(latest.phases) as unknown;
      return normalizePhases(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : undefined);
    } catch {
      return [...PHASES];
    }
  }

  async listCheckouts(): Promise<CheckoutEntity[]> {
    return this.checkouts.find({ order: { name: 'ASC' } });
  }

  async saveCheckout(name: string, path: string): Promise<void> {
    const existing = await this.checkouts.findOne({ where: { name } });
    if (existing) {
      existing.path = path;
      await this.checkouts.save(existing);
      return;
    }
    await this.checkouts.save(this.checkouts.create({ name, path }));
  }

  async listDenyPaths(): Promise<string[]> {
    const rows = await this.denyPaths.find({ order: { pattern: 'ASC' } });
    return rows.map((row) => row.pattern);
  }

  async latestBody(key: string, kind: string): Promise<string | null> {
    return (await this.latestDocument(key, kind))?.body ?? null;
  }

  async latestDocument(key: string, kind: string): Promise<{ id: number; body: string } | null> {
    const run = await this.findRun(key);
    if (!run) {
      return null;
    }
    const found = await this.documents.findOne({
      where: { runId: run.id, kind },
      order: { id: 'DESC' },
    });
    return found ? { id: found.id, body: found.body } : null;
  }

  async putDocument(run: RunEntity, kind: string, body: string): Promise<void> {
    const latest = await this.documents.findOne({
      where: { runId: run.id, kind },
      order: { id: 'DESC' },
    });
    if (latest?.body === body) {
      return;
    }
    await this.documents.save(
      this.documents.create({
        runId: run.id,
        stepStatId: 0,
        kind,
        attempt: 0,
        body,
        path: '',
        createdAt: new Date().toISOString(),
      }),
    );
    this.live?.changed(run.key);
  }

  async hasDocument(key: string, kind: string): Promise<boolean> {
    const run = await this.findRun(key);
    if (!run) {
      return false;
    }
    const found = await this.documents.findOne({ where: { runId: run.id, kind } });
    return found !== null;
  }

  async finishVisit(run: RunEntity, visit: VisitDraft): Promise<StepStatEntity> {
    const previous = await this.stepStats.count({ where: { runId: run.id, step: visit.step } });
    const stats = summarizeSamples(visit.samples);
    const now = visit.finishedAt;
    const stat = await this.stepStats.save(
      this.stepStats.create({
        runId: run.id,
        step: visit.step,
        attempt: previous + 1,
        model: visit.model,
        mode: visit.mode,
        startedAt: visit.startedAt,
        stepStartedAt: run.stepStartedAt,
        finishedAt: visit.finishedAt,
        durationMs: visit.durationMs,
        status: visit.status,
        exitCode: visit.exitCode,
        killReason: visit.killReason,
        tokensIn: visit.tokensIn,
        tokensOut: visit.tokensOut,
        usd: visit.usd,
        cpuAvg: stats.cpuAvg,
        cpuPeak: stats.cpuPeak,
        memAvg: stats.memAvg,
        memPeak: stats.memPeak,
        resumed: visit.resumed ? 1 : 0,
      }),
    );
    for (const sample of visit.samples) {
      await this.samples.save(
        this.samples.create({
          stepStatId: stat.id,
          sampledAt: sample.sampledAt,
          cpuPercent: sample.cpuPercent,
          rssBytes: sample.rssBytes,
        }),
      );
    }
    for (const exchange of visit.exchanges ?? (visit.exchange ? [visit.exchange] : [])) {
      await this.exchanges.save(
        this.exchanges.create({
          stepStatId: stat.id,
          model: exchange.model,
          startedAt: exchange.startedAt,
          finishedAt: exchange.finishedAt,
          durationMs: exchange.durationMs,
          requestText: exchange.requestText,
          responseText: exchange.responseText,
          chatId: exchange.chatId,
          resumed: exchange.resumed ? 1 : 0,
          killReason: exchange.killReason,
        }),
      );
    }
    for (const call of visit.httpCalls) {
      await this.httpCalls.save(
        this.httpCalls.create({
          runId: run.id,
          stepStatId: stat.id,
          provider: call.provider,
          method: call.method,
          url: call.url,
          statusCode: call.statusCode,
          durationMs: call.durationMs,
          error: call.error,
          createdAt: now,
        }),
      );
    }
    for (const document of visit.documents ?? (visit.document ? [visit.document] : [])) {
      const latest = await this.documents.findOne({
        where: { runId: run.id, kind: document.kind },
        order: { id: 'DESC' },
      });
      if (latest?.body !== document.body) {
        await this.documents.save(
          this.documents.create({
            runId: run.id,
            stepStatId: stat.id,
            kind: document.kind,
            attempt: stat.attempt,
            body: document.body,
            path: '',
            createdAt: now,
          }),
        );
      }
    }
    return stat;
  }

  async recordLoop(run: RunEntity, counter: string, attempt: number, reason: string): Promise<void> {
    await this.loops.save(
      this.loops.create({
        runId: run.id,
        counter,
        attempt,
        reason,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  async appendProgress(_key: string, _line: string): Promise<void> {
    return Promise.resolve();
  }

  async listRuns(): Promise<RunEntity[]> {
    return this.runs.find({ order: { createdAt: 'DESC', id: 'DESC' } });
  }

  /** Drop this run's rows and the files swarmloop stored for it. Worktrees stay with prepare. */
  async remove(run: RunEntity): Promise<void> {
    const keys = (await this.listRuns()).map((row) => row.key);
    removeStoredFiles(this.root(), run.key, keys);
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

  async listDocuments(runId: number): Promise<DocumentEntity[]> {
    return this.documents.find({ where: { runId }, order: { id: 'ASC' } });
  }

  async listStats(runId: number): Promise<StepStatEntity[]> {
    return this.stepStats.find({ where: { runId }, order: { id: 'ASC' } });
  }

  async durationByRun(): Promise<Map<number, number>> {
    const stats = await this.stepStats.find({
      select: { id: true, runId: true, step: true, durationMs: true, stepStartedAt: true, startedAt: true, finishedAt: true },
      order: { id: 'ASC' },
    });
    const reports = await this.codeReviewReportMs();
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

  async codeReviewReportMs(runId?: number): Promise<Map<number, number>> {
    const rows: { stepStatId: number | string; durationMs: number | string | null }[] = await this.exchanges.query(
      `SELECT e.step_stat_id AS stepStatId, SUM(e.duration_ms) AS durationMs
       FROM agent_exchanges e
       INNER JOIN step_stats s ON s.id = e.step_stat_id
       WHERE s.step = 'code-review'${runId === undefined ? '' : ' AND s.run_id = ?'}
       GROUP BY e.step_stat_id`,
      runId === undefined ? [] : [runId],
    );
    const totals = new Map<number, number>();
    for (const row of rows) {
      totals.set(Number(row.stepStatId), Number(row.durationMs) || 0);
    }
    return totals;
  }

  async listSamples(statIds: number[]): Promise<ResourceSampleEntity[]> {
    if (statIds.length === 0) {
      return [];
    }
    return this.samples.find({ where: { stepStatId: In(statIds) }, order: { id: 'ASC' } });
  }

  async listExchanges(statIds: number[]): Promise<AgentExchangeEntity[]> {
    if (statIds.length === 0) {
      return [];
    }
    return this.exchanges.find({ where: { stepStatId: In(statIds) }, order: { id: 'ASC' } });
  }

  async latestChatId(runId: number): Promise<string | null> {
    const stats = await this.stepStats.find({ where: { runId }, order: { id: 'DESC' } });
    for (const stat of stats) {
      const exchange = await this.exchanges.findOne({ where: { stepStatId: stat.id }, order: { id: 'DESC' } });
      if (exchange?.chatId) {
        return exchange.chatId;
      }
    }
    return null;
  }

  async listLoops(runId: number): Promise<LoopEventEntity[]> {
    return this.loops.find({ where: { runId }, order: { id: 'ASC' } });
  }

  async listHttpCalls(runId: number): Promise<HttpCallEntity[]> {
    return this.httpCalls.find({ where: { runId }, order: { id: 'ASC' } });
  }

  async listPastes(runKey: string): Promise<PasteEntity[]> {
    return this.pastes.find({ where: { runKey }, order: { id: 'ASC' } });
  }

  async savePaste(runKey: string, url: string, body: string): Promise<void> {
    const existing = await this.pastes.findOne({ where: { runKey, url } });
    if (existing) {
      existing.body = body;
      await this.pastes.save(existing);
    } else {
      await this.pastes.save(this.pastes.create({ runKey, url, body }));
    }
    this.live?.changed(runKey);
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
