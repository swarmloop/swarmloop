import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, realpathSync, statSync } from 'fs';
import { join } from 'path';
import { readEnv } from '../config/env';
import { liveLogBody } from '../acp/live-output';
import { overSpend } from '../limits/limits';
import { RunStop } from '../limits/run-stop';
import { chargeReview, chargeStream, modelForStep } from '../limits/spend';
import { loadPriceTable } from '../limits/prices';
import { resolveRepoRoot } from '../config/repo-root';
import { RunEntity } from '../history/entities';
import { HistoryService } from '../history/history.service';
import { containerName } from '../sandbox/sandbox-launch';
import { SandboxService } from '../sandbox/sandbox.service';
import { SwarmloopError } from '../swarmloop-error';
import { BranchService } from '../steps/branch/branch.service';
import { CommitService } from '../steps/commit/commit.service';
import { MergeRequestService } from '../steps/merge-request/merge-request.service';
import { CodeReviewService } from '../steps/code-review/code-review.service';
import { ImplementReviewService } from '../steps/implement/implement-review.service';
import { ImplementService } from '../steps/implement/implement.service';
import { PlanReviewService } from '../steps/plan/plan-review.service';
import { PipelineStepService } from '../steps/pipeline/pipeline-step.service';
import { PlanService } from '../steps/plan/plan.service';
import { renderProjects, storedProjects } from '../steps/prepare/checkout-path';
import { PrepareService } from '../steps/prepare/prepare.service';
import { ProjectAppendService } from '../steps/prepare/project-append.service';
import { RequirementsService } from '../steps/requirements/requirements.service';
import { ResearchService } from '../steps/research/research.service';
import { joinPrompt, readPlan, withInstructions } from '../steps/plan/plan-record';
import { CHAT_LOCK, chatHeld, chatResume, readChatLock } from './chat-lock';
import { settleShell, shellHolding } from './shell-lock';
import { assertKey, autoContinues, continuesSameStep, countedVisits, continues, diedLog, isStep, loopMark, PipelineResult, settle, STEPS, StepName, StepOptions } from './pipeline-result';

@Injectable()
export class PipelineService implements OnModuleInit {
  private readonly inflight = new Set<string>();

  constructor(
    private readonly history: HistoryService,
    private readonly requirements: RequirementsService,
    private readonly prepare: PrepareService,
    private readonly research: ResearchService,
    private readonly branch: BranchService,
    private readonly commit: CommitService,
    private readonly mergeRequest: MergeRequestService,
    private readonly pipelineStep: PipelineStepService,
    private readonly plan: PlanService,
    private readonly planReview: PlanReviewService,
    private readonly implement: ImplementService,
    private readonly implementReview: ImplementReviewService,
    private readonly codeReview: CodeReviewService,
    private readonly sandbox: SandboxService,
    private readonly config: ConfigService,
    private readonly runStop: RunStop,
    private readonly projects: ProjectAppendService,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const run of await this.history.listRuns()) {
      if (run.status !== 'running' || this.inflight.has(run.key)) {
        continue;
      }
      const body = await this.history.latestBody(run.key, CHAT_LOCK);
      const shell = readChatLock(body);
      if (shell?.container) {
        await settleShell(this.history, this.sandbox, run);
        continue;
      }
      const resume = chatResume(body, run.ownerPid);
      if (resume) {
        run.status = resume;
        run.ownerPid = null;
        await this.history.saveRun(run);
        await this.history.putDocument(run, CHAT_LOCK, 'clear\n');
        continue;
      }
      await this.abandon(run);
    }
  }

  /** One step. `swarmloop step` and the tests use this. */
  async run(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const saved = await this.savedStep(key);
    if ('exitCode' in saved) {
      return saved;
    }
    return this.start(saved.step, key, options);
  }

  /** Keep going until a person has to answer or approve. */
  async runThrough(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const saved = await this.savedStep(key);
    if ('exitCode' in saved) {
      return saved;
    }
    return this.drive(saved.step, key, options);
  }

  /** Kill the running agent and leave the step where it is. */
  async stop(key: string): Promise<PipelineResult> {
    const invalid = this.keyError(key);
    if (invalid) {
      return invalid;
    }
    const run = await this.history.findRun(key);
    if (!run) {
      return { exitCode: 1, message: `${key} is missing` };
    }
    if (!this.inflight.has(key) && run.status !== 'running') {
      return { exitCode: 0, message: `${key} is stopped` };
    }
    const lockBody = await this.history.latestBody(key, CHAT_LOCK);
    if (chatHeld(lockBody, run.status, run.ownerPid)) {
      try {
        await this.sandbox.kill(readChatLock(lockBody)?.container ?? containerName(key, 'chat'));
      } catch (error) {
        const message = error instanceof Error ? error.message : `${key} is still running`;
        return { exitCode: 1, message };
      }
      return { exitCode: 0, message: `${key} stopped` };
    }
    const stopped = await this.stopRunning(key, run);
    if (stopped) {
      return stopped;
    }
    const fresh = await this.history.findRun(key);
    if (fresh?.status === 'running') {
      fresh.status = 'failed';
      fresh.ownerPid = null;
      fresh.stepStartedAt = null;
      await this.history.saveRun(fresh);
    }
    return { exitCode: 0, message: `${key} stopped` };
  }

  /** Save new instructions and run from this step through the rest of the pipeline. */
  async replay(key: string, name: string, prompt: string): Promise<PipelineResult> {
    const invalid = this.keyError(key);
    if (invalid) {
      return invalid;
    }
    if (!isStep(name) || name === 'done') {
      return { exitCode: 1, message: `${name} is unknown` };
    }
    const text = prompt.trim();
    if (!text) {
      return { exitCode: 1, message: 'prompt is missing' };
    }
    const run = await this.history.findRun(key);
    if (!run) {
      return { exitCode: 1, message: `${key} is missing` };
    }
    const stopped = await this.stopRunning(key, run);
    if (stopped) {
      return stopped;
    }
    const fresh = (await this.history.findRun(key)) ?? run;
    const full = await this.storeInstructions(fresh, name, text);
    fresh.currentStep = name;
    fresh.status = 'waiting';
    fresh.ownerPid = null;
    await this.history.saveRun(fresh);
    this.runStop.clear(key);
    return this.startDetached(key, name === 'requirements' ? { prompt: full } : {});
  }

  async startDetached(key: string, options: StepOptions = {}, only?: StepName): Promise<PipelineResult> {
    if (this.inflight.has(key)) {
      return { exitCode: 1, message: `${key} is already running` };
    }
    this.inflight.add(key);
    let started = false;
    try {
      const invalid = this.keyError(key);
      if (invalid) {
        return invalid;
      }
      if (await this.busy(key, true)) {
        return { exitCode: 1, message: `${key} is already running` };
      }
      const existing = await this.history.findRun(key);
      if (!only && existing?.status === 'done') {
        return { exitCode: 0, message: `${key} is done` };
      }
      const step = only ?? existing?.currentStep ?? 'requirements';
      if (!isStep(step) || step === 'done') {
        return { exitCode: 1, message: `${step} is unknown` };
      }
      const flagged = flagError(step, options);
      if (flagged) {
        return { exitCode: 1, message: flagged };
      }
      const pathError = targetError(options.path);
      if (pathError) {
        return { exitCode: 1, message: pathError };
      }
      const missing = await this.missingInput(step, key, options);
      if (missing) {
        return { exitCode: 1, message: `${missing} is missing` };
      }
      if (step === 'requirements' && options.prompt === undefined && options.promptFile === undefined && !existing?.prompt) {
        return { exitCode: 1, message: 'prompt is missing' };
      }
      const blocked = await this.spendStop(key, step);
      if (blocked) {
        return { exitCode: 1, message: blocked };
      }
      if (options.projects?.length && step === 'requirements') {
        await this.pinProjects(key, options.projects);
      }
      started = true;
      void this.drive(step, key, options)
        .catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : 'run failed';
          process.stderr.write(`${message}\n`);
          const run = await this.history.findRun(key);
          if (run?.status === 'running' && run.ownerPid === process.pid) {
            const now = new Date().toISOString();
            await this.history.finishVisit(run, {
              step: run.currentStep,
              model: null,
              mode: null,
              startedAt: run.stepStartedAt ?? now,
              finishedAt: now,
              durationMs: stepElapsed(run.stepStartedAt),
              status: 'failed',
              exitCode: 1,
              killReason: null,
              tokensIn: 0,
              tokensOut: 0,
              usd: 0,
              samples: [],
              exchange: null,
              httpCalls: [],
              document: null,
              documents: [{ kind: 'error', fileName: '', body: `${message}\n` }],
              resumed: false,
            });
            run.status = 'failed';
            run.ownerPid = null;
            run.stepStartedAt = null;
            await this.history.saveRun(run);
          }
        })
        .finally(() => this.inflight.delete(key));
      return { exitCode: 0, message: `${key} started` };
    } finally {
      if (!started) {
        this.inflight.delete(key);
      }
    }
  }

  async fetch(key: string): Promise<PipelineResult> {
    const invalid = this.keyError(key);
    if (invalid) {
      return invalid;
    }
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
      return { exitCode: 1, message: `${key} is not a Jira key` };
    }
    if (await this.busy(key)) {
      return { exitCode: 1, message: `${key} is already running` };
    }
    try {
      return await this.requirements.fetch(key);
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : 'requirements failed';
      return { exitCode: 1, message };
    }
  }

  async step(name: string, key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const invalid = this.keyError(key);
    if (invalid) {
      return invalid;
    }
    if (!isStep(name)) {
      return { exitCode: 1, message: `${name} is unknown` };
    }
    return this.start(name, key, options);
  }

  private async start(name: StepName, key: string, options: StepOptions): Promise<PipelineResult> {
    const flagged = flagError(name, options);
    if (flagged) {
      return { exitCode: 1, message: flagged };
    }
    const pathError = targetError(options.path);
    if (pathError) {
      return { exitCode: 1, message: pathError };
    }
    const missing = await this.missingInput(name, key, options);
    if (missing) {
      return { exitCode: 1, message: `${missing} is missing` };
    }
    if (await this.busy(key)) {
      return { exitCode: 1, message: `${key} is already running` };
    }
    const blocked = await this.spendStop(key, name);
    if (blocked) {
      return { exitCode: 1, message: blocked };
    }
    return this.execute(name, key, options);
  }

  private async abandon(run: RunEntity): Promise<void> {
    const now = new Date().toISOString();
    const note = 'process died\n';
    const saved = await this.savedOutput(run);
    const log = diedLog(saved);
    const env = readEnv(this.config);
    const prices = await loadPriceTable(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), env.RUNTIME);
    const model = modelForStep(run.currentStep, env);
    const charge = run.currentStep === 'code-review' ? await chargeReview(this.history.root(), run.key, env, prices) : model ? chargeStream(model, saved, prices) : null;
    run.spentUsd += charge?.usd ?? 0;
    await this.history.finishVisit(run, {
      step: run.currentStep,
      model,
      mode: null,
      startedAt: run.stepStartedAt ?? run.updatedAt,
      finishedAt: now,
      durationMs: stepElapsed(run.stepStartedAt),
      status: 'failed',
      exitCode: 1,
      killReason: 'process died',
      tokensIn: charge?.tokensIn ?? 0,
      tokensOut: charge?.tokensOut ?? 0,
      usd: charge?.usd ?? 0,
      samples: [],
      exchange: null,
      httpCalls: [],
      document: null,
      documents: [
        { kind: 'log', fileName: '', body: log },
        { kind: 'error', fileName: '', body: note },
      ],
      resumed: false,
    });
    run.status = 'failed';
    run.ownerPid = null;
    run.stepStartedAt = null;
    await this.history.saveRun(run);
  }

  private async savedOutput(run: RunEntity): Promise<string> {
    return liveLogBody(this.history.root(), run.key, run.currentStep);
  }

  private async pinProjects(key: string, names: string[]): Promise<void> {
    const body = renderProjects(names);
    const existing = await this.history.findRun(key);
    if (existing) {
      if (!storedProjects(existing.projects).length) {
        existing.projects = body;
        await this.history.saveRun(existing);
      }
      return;
    }
    const created = await this.history.openWaiting(key, '');
    created.targetPath = null;
    created.projects = body;
    await this.history.saveRun(created);
  }

  private async savedStep(key: string): Promise<{ step: StepName } | PipelineResult> {
    const invalid = this.keyError(key);
    if (invalid) {
      return invalid;
    }
    if (await this.busy(key)) {
      return { exitCode: 1, message: `${key} is already running` };
    }
    const existing = await this.history.findRun(key);
    if (existing?.status === 'done') {
      return { exitCode: 0, message: `${key} is done` };
    }
    const step = existing?.currentStep ?? 'requirements';
    if (!isStep(step)) {
      return { exitCode: 1, message: `${step} is unknown` };
    }
    return { step };
  }

  private async drive(name: StepName, key: string, options: StepOptions): Promise<PipelineResult> {
    let step = name;
    let stepOptions = options;
    let manual = options.auto !== true;
    let result: PipelineResult = { exitCode: 0, message: `${key} started` };
    let ran = false;
    for (let hop = 0; hop < HOP_LIMIT; hop += 1) {
      const blocked = await this.spendStop(key, step);
      if (blocked) {
        return { exitCode: ran ? 0 : 1, message: blocked };
      }
      result = await this.execute(step, key, stepOptions);
      ran = true;
      if (manual) {
        await this.markLoop(key);
        manual = false;
      }
      if (this.runStop.halted(key)) {
        return result;
      }
      const run = await this.history.findRun(key);
      const next = continues(step, run);
      const mark = loopMark(await this.history.latestBody(key, 'loop_mark'));
      const visits = next && run ? countedVisits(await this.history.listStats(run.id), next, mark) : 0;
      const following = autoContinues(step, run, visits, readEnv(this.config).MAX_RETURNS);
      if (!following) {
        return result;
      }
      step = following;
      stepOptions = { auto: true };
    }
    return result;
  }

  /** Refuse a step that has not started once recorded spend is at the ceiling. */
  private async spendStop(key: string, step: StepName): Promise<string | null> {
    const existing = await this.history.findRun(key);
    if (!existing || !overSpend(existing.spentUsd, readEnv(this.config).MAX_RUN_USD)) {
      return null;
    }
    const stats = await this.history.listStats(existing.id);
    const last = [...stats].reverse().find((item) => item.step === step)?.status ?? null;
    if (continuesSameStep(existing.status, existing.currentStep, step, last)) {
      return null;
    }
    const message = `${key} is over the spend limit. ${step} was not started`;
    await this.history.putDocument(existing, 'spend', `${message}\n`);
    return message;
  }

  private async markLoop(key: string): Promise<void> {
    const run = await this.history.findRun(key);
    if (!run) {
      return;
    }
    const stats = await this.history.listStats(run.id);
    const mark = stats.reduce((max, item) => Math.max(max, item.id), 0);
    await this.history.putDocument(run, 'loop_mark', `${mark}\n`);
  }

  private async execute(name: StepName, key: string, options: StepOptions): Promise<PipelineResult> {
    const pendingError = await this.applyPending(key);
    if (pendingError) {
      return { exitCode: 1, message: pendingError };
    }
    const handler = this.handlers()[name];
    if (handler) {
      return handler(key, options);
    }
    let sandboxError: string | null = null;
    if (isModelStep(name)) {
      try {
        await this.sandbox.assertReady(readEnv(this.config).RUNTIME);
      } catch (error) {
        sandboxError = error instanceof SwarmloopError ? error.message : 'sandbox failed';
      }
    }
    const prior = await this.history.findRun(key);
    const previousStep = prior?.currentStep ?? name;
    const previousStatus = prior?.status ?? 'waiting';
    const run = await this.history.begin(key, name);
    if (options.path) {
      run.targetPath = realpathSync(options.path);
    }
    const settled = settle(previousStep, previousStatus, name, sandboxError ? 'failed' : 'blocked');
    run.status = settled.status;
    run.currentStep = settled.currentStep;
    run.ownerPid = null;
    await this.history.saveRun(run);
    const line = `${new Date().toISOString()} ${sandboxError ?? `${name} not implemented`}`;
    await this.history.appendProgress(key, line);
    return { exitCode: 1, message: line };
  }

  /** A queued repository is mounted before the step reads its worktree list. */
  private async applyPending(key: string): Promise<string | null> {
    try {
      await this.projects.flush(key);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'repository failed';
      const run = await this.history.findRun(key);
      if (run && run.status !== 'running') {
        run.status = 'failed';
        run.ownerPid = null;
        await this.history.saveRun(run);
        await this.history.putDocument(run, 'error', `${message}\n`);
      }
      return message;
    }
  }

  private handlers(): Partial<Record<StepName, (key: string, options: StepOptions) => Promise<PipelineResult>>> {
    return {
      requirements: (key, options) => this.guard(this.requirements.execute(key, options), 'requirements failed'),
      prepare: (key) => this.prepare.execute(key),
      research: (key, options) => this.research.execute(key, options),
      branch: (key) => this.branch.execute(key),
      plan: (key, options) => this.plan.execute(key, options),
      'plan-review': (key, options) => this.planReview.execute(key, options),
      implement: (key, options) => this.implement.execute(key, options),
      'implement-review': (key, options) => this.implementReview.execute(key, options),
      'code-review': (key, options) => this.codeReview.execute(key, options),
      commit: (key) => this.commit.execute(key),
      'merge-request': (key, options) => this.mergeRequest.execute(key, options),
      pipeline: (key, options) => this.pipelineStep.execute(key, options),
    };
  }

  private async guard(result: Promise<PipelineResult>, fallback: string): Promise<PipelineResult> {
    try {
      return await result;
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : fallback;
      return { exitCode: 1, message };
    }
  }

  private async missingInput(name: StepName, key: string, options: StepOptions): Promise<string | null> {
    if (name === 'code-review' && (options.path || (await this.storedCheckout(key)) || (await this.foreignReview(key)))) {
      return null;
    }
    if (name === 'requirements' || name === 'done') {
      return null;
    }
    if (name === 'research') {
      const path = join(this.history.root(), 'worktrees', key);
      return existsSync(path) ? null : `worktrees/${key}`;
    }
    if (name === 'plan-review' || name === 'implement') {
      const plan = readPlan(await this.history.latestBody(key, 'requirements'));
      return plan ? null : 'plan';
    }
    const kind = requiredKind(name);
    if (!kind) {
      return null;
    }
    return (await this.history.hasDocument(key, kind)) ? null : kind;
  }

  private async foreignReview(key: string): Promise<boolean> {
    const run = await this.history.findRun(key);
    if (!run) {
      return false;
    }
    return !(await this.history.activePhases(run.id)).includes('implementation');
  }

  private async storedCheckout(key: string): Promise<boolean> {
    const run = await this.history.findRun(key);
    return Boolean(run?.targetPath) && !(await this.history.hasDocument(key, 'implementation'));
  }

  claimed(key: string): boolean {
    return this.inflight.has(key);
  }

  private async stopRunning(key: string, run: RunEntity): Promise<PipelineResult | null> {
    if (!this.inflight.has(key) && run.status !== 'running') {
      this.runStop.clear(key);
      return null;
    }
    this.runStop.halt(key);
    if (isStep(run.currentStep) && run.currentStep !== 'done') {
      await this.sandbox.killFamily(key, run.currentStep);
    }
    const idle = await this.untilIdle(key);
    if (!idle) {
      return { exitCode: 1, message: `${key} is still running` };
    }
    this.runStop.clear(key);
    return null;
  }

  private async storeInstructions(run: RunEntity, step: StepName, text: string): Promise<string> {
    const prompt = joinPrompt(run.prompt, text);
    run.prompt = prompt;
    await this.history.saveRun(run);
    if (step === 'requirements') {
      return prompt;
    }
    const body = await this.history.latestBody(run.key, 'requirements');
    if (body) {
      const revise = STEPS.indexOf(step) <= STEPS.indexOf('plan');
      await this.history.putDocument(run, 'requirements', withInstructions(body, text, revise));
    }
    return prompt;
  }

  private untilIdle(key: string): Promise<boolean> {
    const deadline = Date.now() + 20_000;
    return new Promise((resolve) => {
      const tick = (): void => {
        if (!this.inflight.has(key)) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  private async busy(key: string, ownClaim = false): Promise<boolean> {
    if (!ownClaim && this.inflight.has(key)) {
      return true;
    }
    const existing = await this.history.findRun(key);
    if (!existing) {
      return false;
    }
    const settled = await settleShell(this.history, this.sandbox, existing);
    if (shellHolding(await this.history.latestBody(key, CHAT_LOCK), settled.status)) {
      return true;
    }
    return this.history.held(settled);
  }

  private keyError(key: string): PipelineResult | null {
    try {
      assertKey(key);
      return null;
    } catch (error) {
      return { exitCode: 1, message: error instanceof Error ? error.message : 'key is invalid' };
    }
  }
}

/** One pass, then the return loops. A stuck advance stops here. */
const HOP_LIMIT = STEPS.length * 3;

const MODEL_STEPS = new Set<StepName>(['research', 'plan', 'plan-review', 'implement', 'implement-review', 'code-review']);

function isModelStep(name: StepName): boolean {
  return MODEL_STEPS.has(name);
}

function flagError(name: StepName, options: StepOptions): string | null {
  if ((options.prompt !== undefined || options.promptFile !== undefined) && name !== 'requirements') {
    return 'prompt is only valid for requirements';
  }
  if (options.path && name !== 'code-review') {
    return 'path is only valid for code-review';
  }
  return null;
}

function targetError(path: string | undefined): string | null {
  if (path === undefined) {
    return null;
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    return 'path is not a directory';
  }
  return null;
}

function requiredKind(name: StepName): string | null {
  switch (name) {
    case 'prepare':
      return 'requirements';
    case 'branch':
    case 'plan':
      return 'repos';
    case 'implement-review':
    case 'code-review':
      return 'implementation';
    case 'commit':
    case 'merge-request':
      return 'requirements';
    case 'pipeline':
      return 'pipeline_ref';
    default:
      return null;
  }
}

function stepElapsed(startedAt: string | null): number {
  if (!startedAt) {
    return 0;
  }
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
}
