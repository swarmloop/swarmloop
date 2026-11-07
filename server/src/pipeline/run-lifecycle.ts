import type { OnModuleInit } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { existsSync, statSync } from 'fs';
import type { AppConfig } from '../config/env';
import { chargeStream, modelForStep } from '../agent/spend';
import { loadPriceTable } from '../agent/prices';
import { resolveRepoRoot } from '../config/repo-root';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { RunRepository } from '../history/run.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { SandboxService } from '../sandbox/sandbox.service';
import type { Clock } from '../core/clock';
import type { RequirementsStep } from '../steps/requirements/requirements.step';
import type { StepRegistry } from '../steps/step.registry';
import type { RunStop } from '../agent/run-stop';
import type { PipelineResult, StepOptions } from '../core/pipeline-result';
import { assertKey, diedLog, isStep } from '../core/pipeline-result';
import { writeRunState } from '../history/run-state';
import { ERROR_CODES } from '../contract/error-codes';
import { REASON, STOP_NOTE } from '../contract/run-state';
import { reportFailure } from '../steps/shared/step-failure';
import { CHAT_LOCK, chatHeld, chatResume, readChatLock } from './chat-lock';
import { flagError } from './flag-error';
import { settleShell, shellHolding } from './shell-lock';
import type { RunDriver } from './run-driver';
import type { RunInstructions } from './run-instructions';
import type { StepName } from '../contract/steps';
import { STEPS } from '../contract/steps';

export class RunLifecycle implements OnModuleInit {
  private readonly logger = new Logger('PipelineService');
  private readonly inflight = new Set<string>();
  private readonly idleWaiters = new Map<string, Set<() => void>>();
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly registry: StepRegistry,
    private readonly config: AppConfig,
    private readonly visits: VisitRepository,
    private readonly runStop: RunStop,
    private readonly clock: Clock,
    private readonly sandbox: SandboxService,
    private readonly requirements: RequirementsStep,
    private readonly driver: RunDriver,
    private readonly instructions: RunInstructions,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const run of await this.runs.listRuns()) {
      if (run.status !== 'running' || this.inflight.has(run.key)) {
        continue;
      }
      const body = await this.documents.latestBody(run.key, CHAT_LOCK);
      const shell = readChatLock(body);
      if (shell?.container) {
        await settleShell(this.runs, this.documents, this.sandbox, run, this.clock);
        continue;
      }
      const resume = chatResume(body, run.ownerPid);
      if (resume) {
        await this.runs.release(run, { status: resume });
        await this.documents.putDocument(run, CHAT_LOCK, 'clear\n');
        continue;
      }
      await this.abandon(run);
    }
  }

  async startDetached(key: string, options: StepOptions = {}, only?: StepName): Promise<PipelineResult> {
    if (this.inflight.has(key)) return { exitCode: 1, message: `${key} is already running` };
    this.inflight.add(key);
    let started = false;
    try {
      const prepared = await this.prepareDetached(key, options, only);
      if ('exitCode' in prepared) return prepared;
      const { step } = prepared;
      started = true;
      this.runStop.clear(key);
      void this.driver
        .drive(step, key, options)
        .catch(async (error: unknown) => {
          // A failed lookup must not hide the crash: it is reported below with the key as the step.
          const run = await this.runs.findRun(key).catch(() => null);
          const failure = reportFailure(run?.currentStep ?? key, error, this.config.env);
          if (run?.status === 'running' && run.ownerPid === process.pid) {
            const now = this.clock.iso();
            writeRunState(run, { status: 'failed', ownerPid: null });
            await this.visits.finalize(run.activeAttempt, run, {
              step: run.currentStep,
              model: null,
              mode: null,
              startedAt: run.stepStartedAt ?? now,
              finishedAt: now,
              durationMs: stepElapsed(run.stepStartedAt, this.clock.now()),
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
              documents: [{ kind: 'error', fileName: '', body: `${failure.message}\n` }],
              resumed: false,
            });
          }
        })
        .finally(() => this.release(key));
      return { exitCode: 0, message: `${key} started` };
    } finally {
      if (!started) this.release(key);
    }
  }

  private async prepareDetached(
    key: string,
    options: StepOptions,
    only?: StepName,
  ): Promise<{ step: StepName } | PipelineResult> {
    const invalid = this.keyError(key);
    if (invalid) return invalid;
    if (await this.busy(key, true)) return { exitCode: 1, message: `${key} is already running` };
    const existing = await this.runs.findRun(key);
    if (!only && existing?.status === 'done') return { exitCode: 0, message: `${key} is done` };
    const step = only ?? existing?.currentStep ?? STEPS[0];
    const validated = await this.validateDetachedStep(key, step, options, existing?.prompt);
    return typeof validated === 'string' ? { step: validated } : validated;
  }

  private async validateDetachedStep(
    key: string,
    step: string,
    options: StepOptions,
    existingPrompt: string | null | undefined,
  ): Promise<StepName | PipelineResult> {
    if (!isStep(step) || step === 'done') return { exitCode: 1, message: `${step} is unknown` };
    const target = this.registry.get(step);
    const flagged = flagError(target, options);
    if (flagged) return { exitCode: 1, message: flagged };
    const pathError = targetError(options.path);
    if (pathError) return { exitCode: 1, message: pathError };
    const missing = await this.driver.missingInput(step, key, options);
    if (missing) return { exitCode: 1, message: `${missing} is missing` };
    if (
      target?.capabilities.prompt &&
      options.prompt === undefined &&
      options.promptFile === undefined &&
      !existingPrompt
    ) {
      return { exitCode: 1, message: 'prompt is missing' };
    }
    const blocked = await this.driver.spendStop(key, step);
    if (blocked) return { exitCode: 1, message: blocked };
    if (options.projects?.length && target?.capabilities.projects)
      await this.instructions.pinProjects(key, options.projects);
    return step;
  }

  async stop(key: string): Promise<PipelineResult> {
    const invalid = this.keyError(key);
    if (invalid) {
      return invalid;
    }
    const run = await this.runs.findRun(key);
    if (!run) {
      return { exitCode: 1, message: `${key} is missing` };
    }
    if (!this.inflight.has(key) && run.status !== 'running' && !this.runStop.halted(key)) {
      return { exitCode: 0, message: `${key} is stopped` };
    }
    const lockBody = await this.documents.latestBody(key, CHAT_LOCK);
    if (chatHeld(lockBody, run.status, run.ownerPid)) {
      if ((await this.sandbox.stopRun(key, 'shell', this.config.env.STOP_GRACE_S)) === 'unknown') {
        return { exitCode: 1, message: silentMessage(key) };
      }
      return { exitCode: 0, message: `${key} stopped` };
    }
    const stopped = await this.stopRunning(key, run);
    if (stopped) {
      return stopped;
    }
    // The driver has left and no labeled container is listed. A step that closed on its own stays as it ended.
    const fresh = await this.runs.findRun(key);
    if (fresh?.status === 'running' || fresh?.status === 'failed') {
      await this.runs.release(fresh, {
        status: 'blocked',
        reason: { code: REASON.stopped, message: STOP_NOTE },
        stepStartedAt: null,
      });
    }
    this.runStop.clear(key);
    return { exitCode: 0, message: `${key} stopped` };
  }

  private async abandon(run: RunEntity): Promise<void> {
    const now = this.clock.iso();
    const note = 'process died\n';
    const saved = this.instructions.savedOutput(run);
    const log = diedLog(saved);
    const env = this.config.env;
    const prices = await loadPriceTable(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), env.RUNTIME, this.clock.now());
    const model = modelForStep(run.currentStep, env);
    const step = isStep(run.currentStep) ? this.registry.get(run.currentStep) : null;
    const charge = step?.charge
      ? await step.charge(run.key, env, prices)
      : model
        ? chargeStream(model, saved, prices)
        : null;
    run.spentUsd += charge?.usd ?? 0;
    writeRunState(run, { status: 'failed', ownerPid: null });
    await this.visits.finalize(run.activeAttempt, run, {
      step: run.currentStep,
      model,
      mode: null,
      startedAt: run.stepStartedAt ?? run.updatedAt,
      finishedAt: now,
      durationMs: stepElapsed(run.stepStartedAt, this.clock.now()),
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
  }

  claimed(key: string): boolean {
    return this.inflight.has(key);
  }

  whenIdle(key: string): Promise<void> {
    if (!this.inflight.has(key)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiters = this.idleWaiters.get(key) ?? new Set<() => void>();
      waiters.add(resolve);
      this.idleWaiters.set(key, waiters);
    });
  }

  private release(key: string): void {
    this.inflight.delete(key);
    const waiters = this.idleWaiters.get(key);
    this.idleWaiters.delete(key);
    waiters?.forEach((resolve) => resolve());
  }

  async stopRunning(key: string, run: RunEntity): Promise<PipelineResult | null> {
    if (!this.inflight.has(key) && run.status !== 'running' && !this.runStop.halted(key)) {
      return null;
    }
    this.runStop.halt(key);
    if ((await this.stopContainers(key, run)) === 'unknown') {
      return this.dockerSilent(key);
    }
    const idle = await this.untilIdle(key);
    if (!idle) {
      return { exitCode: 1, message: `${key} is still running` };
    }
    // The driver may have started a container before it saw the intent: list again now that it has left.
    return (await this.stopContainers(key, run)) === 'unknown' ? this.dockerSilent(key) : null;
  }

  private stopContainers(key: string, run: RunEntity): Promise<'gone' | 'unknown'> {
    return this.sandbox.stopRun(key, run.currentStep, this.config.env.STOP_GRACE_S);
  }

  /** Docker did not answer: the run is blocked, not stopped, and the intent stays until a Resume. */
  private async dockerSilent(key: string): Promise<PipelineResult> {
    const fresh = await this.runs.findRun(key);
    if (fresh?.status === 'running') {
      await this.runs.release(fresh, {
        status: 'blocked',
        reason: { code: ERROR_CODES.RESOURCE_UNKNOWN, message: silentMessage(key) },
        stepStartedAt: null,
      });
    }
    return { exitCode: 1, message: silentMessage(key) };
  }

  protected untilIdle(key: string): Promise<boolean> {
    const deadline = this.clock.now() + 20_000;
    return new Promise((resolve) => {
      const tick = (): void => {
        if (!this.inflight.has(key)) {
          resolve(true);
          return;
        }
        if (this.clock.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  async busy(key: string, ownClaim = false): Promise<boolean> {
    if (!ownClaim && this.inflight.has(key)) {
      return true;
    }
    const existing = await this.runs.findRun(key);
    if (!existing) {
      return false;
    }
    const settled = await settleShell(this.runs, this.documents, this.sandbox, existing, this.clock);
    if (shellHolding(await this.documents.latestBody(key, CHAT_LOCK), settled.status)) {
      return true;
    }
    return this.runs.held(settled);
  }

  keyError(key: string): PipelineResult | null {
    try {
      assertKey(key);
      return null;
    } catch (error) {
      return { exitCode: 1, message: error instanceof Error ? error.message : 'key is invalid' };
    }
  }
}

function silentMessage(key: string): string {
  return `${key} is blocked: docker did not answer`;
}
function targetError(path: string | undefined): string | null {
  if (path === undefined) return null;
  if (!existsSync(path) || !statSync(path).isDirectory()) return 'path is not a directory';
  return null;
}
function stepElapsed(startedAt: string | null, now: number): number {
  if (!startedAt) return 0;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}
