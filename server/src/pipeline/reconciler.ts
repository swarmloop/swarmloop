import type { OnModuleDestroy } from '@nestjs/common';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConnectionsService } from '../auth/connections.service';
import { AppConfig } from '../config/env';
import { agentFor, agentsFor } from '../config/agents';
import { chargeStream } from '../agent/spend';
import { loadPriceTable } from '../agent/prices';
import { resolveRepoRoot } from '../config/repo-root';
import { ERROR_CODES } from '../contract/error-codes';
import { REASON } from '../contract/run-state';
import type { StepName } from '../contract/steps';
import { hasFinalResult, stepOutput } from '../core/attempt-output';
import { barrier } from '../core/barrier';
import { Clock } from '../core/clock';
import { AwakeTime } from '../core/awake-time';
import { delay } from '../core/delay';
import { isStep } from '../core/pipeline-result';
import { SERVER_INSTANCE } from '../core/server-instance';
import { recordStepEvent, runInStepScope } from '../core/step-event-scope';
import type { RunEntity } from '../history/entities';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { deriveState, writeRunState } from '../history/run-state';
import { RuntimeCooldownRepository } from '../history/runtime-cooldown.repository';
import { StepEventLog } from '../history/step-event.log';
import type { VisitDraft } from '../history/visit';
import { VisitRepository } from '../history/visit.repository';
import { SandboxService } from '../sandbox/sandbox.service';
import { fingerprintOf, parseJournal, unfinished, REBASE_JOURNAL } from '../git/rebase';
import { MergeRequestLookup } from '../steps/merge-request/merge-request-lookup';
import { RunRebase } from '../steps/run-rebase';
import { StepRegistry } from '../steps/step.registry';
import { CHAT_LOCK, chatResume, readChatLock } from './chat-lock';
import { CommandService } from './command.service';
import { MergeWatch } from './merge-watch';
import { SubtaskPort } from './subtask-port';
import { WorkspaceGuard, workspaceBlock } from './workspace-guard';
import { settleShell } from './shell-lock';

/** Waits between the read-only probes of a docker that does not answer. */
const PROBE_BACKOFF_MS = [1_000, 2_000];

export function silentMessage(key: string): string {
  return `${key} is blocked: docker did not answer`;
}

/**
 * One idempotent look at the runs and commands that a process left behind. It runs at startup and every
 * `RECONCILE_MS`. A run it has settled is no longer `running`, so a second pass without new facts changes nothing.
 */
@Injectable()
export class Reconciler implements OnModuleDestroy {
  private readonly logger = new Logger(Reconciler.name);
  private claimed: (key: string) => boolean = () => false;
  private timer: NodeJS.Timeout | null = null;
  private tick: Promise<void> | null = null;
  private awake: AwakeTime | null = null;
  /** When the merge watch last ran. Null before its first pass. */
  private watchedAt: number | null = null;
  /** Host suspensions seen by the timer, so a wait that began before one does not count it. */
  private readonly slept: { at: number; ms: number }[] = [];

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly visits: VisitRepository,
    private readonly sandbox: SandboxService,
    private readonly registry: StepRegistry,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly commands: CommandService,
    private readonly events: StepEventLog,
    private readonly mergeRequests: MergeRequestLookup,
    private readonly rebases: RunRebase,
    private readonly workspace: WorkspaceGuard,
    private readonly cooldowns: RuntimeCooldownRepository,
    private readonly subtasks: SubtaskPort,
    private readonly mergeWatch: MergeWatch,
    @Optional() private readonly connections?: ConnectionsService,
  ) {}

  /** The startup pass over the runs. `claimed` says which runs a step of this process holds. */
  async start(claimed: (key: string) => boolean): Promise<void> {
    this.claimed = claimed;
    await this.reconcileRuns();
  }

  /**
   * Starts the timer. Only the API server calls it: a CLI process holds no claims for the runs it does not drive,
   * so its timer would take the runs of the server for dead ones.
   */
  schedule(): void {
    this.stop();
    this.awake = new AwakeTime(this.clock, this.config.env.RECONCILE_MS);
    this.timer = setInterval(() => this.tickOnce(), this.config.env.RECONCILE_MS);
    this.timer.unref();
  }

  /** Stops the timer and waits for the tick that runs, so nothing reads the database after it closes. */
  async onModuleDestroy(): Promise<void> {
    this.stop();
    await this.tick;
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A tick that comes while the last one still works is skipped. A failed tick is logged and the next one runs. */
  private tickOnce(): void {
    const gap = this.awake?.observe() ?? 0;
    if (gap > 0) this.slept.push({ at: this.clock.now(), ms: gap });
    if (this.tick) return;
    this.tick = this.reconcileAll()
      .catch((error: unknown) => {
        this.logger.warn(`reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.tick = null;
      });
  }

  private async reconcileAll(): Promise<void> {
    await this.reconcileRuns();
    await this.resumeLimited();
    await this.resumeGitAuth();
    await this.resumeSubtaskParents();
    await this.watchMerges();
    await this.reconcileCommands();
  }

  /** The runs in `running`, `stopping` or `recovering`: all three are a `running` status. */
  async reconcileRuns(): Promise<void> {
    for (const run of await this.runs.listRuns()) {
      if (run.status !== 'running') continue;
      try {
        await this.reconcile(run);
      } catch (error) {
        this.logger.warn(`reconcile of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * A run that waits for a provider limit goes on by itself, once, when an agent of its role is free again: at the
   * earliest end of the cooldowns of its runtimes, a minute after a reset the provider named.
   */
  async resumeLimited(): Promise<void> {
    for (const run of await this.runs.listRuns()) {
      if (run.status !== 'waiting' || deriveState(run).reason?.code !== ERROR_CODES.RUNTIME_LIMIT) continue;
      try {
        const runtimes = agentsFor(this.config.env, run, run.currentStep).map((agent) => agent.runtime);
        if (this.clock.now() < (await this.cooldowns.earliest(runtimes)).resumeAt) continue;
        await this.commands.accept('resume', run.key, {}, { idempotencyKey: `limit-${run.revision}` });
      } catch (error) {
        this.logger.warn(`resume of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** A run that waits for a person to reconnect goes on by itself, once, when their connection is ok again. */
  async resumeGitAuth(): Promise<void> {
    for (const run of await this.runs.listRuns()) {
      if (run.status !== 'waiting' || deriveState(run).reason?.code !== ERROR_CODES.GIT_AUTH) continue;
      try {
        if (!run.startedBy || !(await this.connections?.isHealthy(run.startedBy))) continue;
        await this.commands.accept('resume', run.key, {}, { idempotencyKey: `git-auth-${run.revision}` });
      } catch (error) {
        this.logger.warn(`resume of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * A split run waits between its passes. The timer and a restart resume it only when its subtasks changed since
   * the last pass (an event was lost) or when no pass recorded them yet.
   */
  async resumeSubtaskParents(): Promise<void> {
    for (const run of await this.runs.listRuns()) {
      if (run.status !== 'waiting' || !this.subtasks.passDue(run)) continue;
      try {
        if (!(await this.subtasks.subtasksChanged(run))) continue;
        await this.subtasks.resumeParent(run, `subtasks-${run.revision}`);
      } catch (error) {
        this.logger.warn(`resume of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** The done runs are looked at through the code host every `MERGE_WATCH_MIN` minutes, not on every tick. */
  async watchMerges(): Promise<void> {
    const now = this.clock.now();
    if (this.watchedAt !== null && now - this.watchedAt < this.config.env.MERGE_WATCH_MIN * 60_000) return;
    this.watchedAt = now;
    await this.mergeWatch.run();
  }

  /** The commands a process left `accepted` or `executing`. */
  reconcileCommands(): Promise<void> {
    return this.commands.recover();
  }

  async reconcile(seen: RunEntity): Promise<void> {
    const run = await this.runs.findRun(seen.key);
    if (run?.status !== 'running') return;
    const body = await this.documents.latestBody(run.key, CHAT_LOCK);
    const lock = readChatLock(body);
    if (lock?.container) {
      await settleShell(this.runs, this.documents, this.sandbox, run, this.clock);
      return;
    }
    if (this.ownedHere(run, lock?.pid)) return;
    const resume = chatResume(body, run.ownerPid);
    if (resume) {
      await this.runs.release(run, { status: resume });
      await this.documents.putDocument(run, CHAT_LOCK, 'clear\n');
      return;
    }
    if (await this.settleRebase(run)) return;
    await this.settleAttempt(run);
  }

  /**
   * A journal below `completed` is read before the run continues or blocks. Files that no longer match the last
   * checkpoint block it with `REBASE_CONFLICT`; otherwise the rebase resumes through `RunRebase`, without a new
   * generation. A repo in `conflict` waits for a person, so it is neither.
   */
  private async settleRebase(run: RunEntity): Promise<boolean> {
    const journal = parseJournal(await this.documents.latestBody(run.key, REBASE_JOURNAL));
    if (!unfinished(journal)) return false;
    const open = Object.entries(journal).filter(([, entry]) => entry.checkpoint !== 'completed');
    if (open.some(([, entry]) => entry.generation !== run.generation)) return false;
    if (open.some(([, entry]) => entry.checkpoint === 'conflict')) return false;
    if (await this.workspaceBlocked(run)) return true;
    for (const [repo, entry] of open) {
      if ((await fingerprintOf(entry.path)) === entry.fingerprint) continue;
      await this.runs.release(run, {
        status: 'blocked',
        reason: {
          code: ERROR_CODES.REBASE_CONFLICT,
          message: `${repo} rebase blocked: the files changed since the journal was written`,
        },
        stepStartedAt: null,
      });
      return true;
    }
    await this.runs.release(run, { status: 'failed', stepStartedAt: null });
    try {
      await this.rebases.rebase(run.key, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'rebase failed';
      await this.runs.release((await this.runs.findRun(run.key)) ?? run, {
        status: 'blocked',
        reason: { code: ERROR_CODES.REBASE_CONFLICT, message },
        stepStartedAt: null,
      });
    }
    return true;
  }

  /**
   * The worktrees are back before the rebase relaunches. A run that cannot get them is blocked with the code of the
   * cause, never retried: only a person can fix a lost workspace, a branch in use or a diverged branch.
   */
  private async workspaceBlocked(run: RunEntity): Promise<boolean> {
    try {
      await this.workspace.ensure(run);
      return false;
    } catch (error) {
      const block = workspaceBlock(error);
      if (!block) throw error;
      await this.runs.release(run, {
        status: 'blocked',
        reason: { code: block.code, message: block.message },
        stepStartedAt: null,
      });
      return true;
    }
  }

  /** The owner is this process and its step is in flight, or a chat of this process holds the run. */
  private ownedHere(run: RunEntity, chatPid: number | undefined): boolean {
    const chat = chatPid !== undefined && chatPid === run.ownerPid && run.ownerPid === process.pid;
    return chat || (run.ownerInstance === SERVER_INSTANCE && this.claimed(run.key));
  }

  private async settleAttempt(run: RunEntity): Promise<void> {
    const output = stepOutput(this.root, run.key, run.currentStep, run.activeAttempt);
    if (hasFinalResult(output)) {
      await this.interrupted(run, output);
      return;
    }
    const attemptId = run.activeAttempt;
    const container = attemptId === null ? false : await this.probe(attemptId);
    if (container === null) {
      await this.blocked(run);
      return;
    }
    if (container) {
      const since = recoveringSince(run);
      if (since === null) {
        writeRunState(run, {
          status: 'running',
          ownerPid: null,
          reason: { code: REASON.recovering, message: this.clock.iso() },
          facts: { recovering: true },
        });
        await this.runs.saveRun(run);
        return;
      }
      const asleep = this.slept.filter((gap) => gap.at > since).reduce((sum, gap) => sum + gap.ms, 0);
      if (this.clock.now() - since - asleep < this.config.env.RECOVER_WAIT_MS) return;
      if (!(await this.sandbox.killAttempt(attemptId!))) {
        await this.blocked(run);
        return;
      }
    }
    if (run.currentStep === 'merge-request') await this.confirmMergeRequest(run);
    await this.recordInterrupted(run);
    await this.interrupted(run, output);
  }

  /**
   * A merge request that the code host already has for the branch of the run is stored, so the relaunch finds it and
   * never opens a second. Read-only: a lookup that fails leaves the run as it is.
   */
  private async confirmMergeRequest(run: RunEntity): Promise<void> {
    if (!run.codeHost) return;
    try {
      if (await this.documents.latestBody(run.key, 'merge_request')) return;
      const refs = await this.documents.latestBody(run.key, 'pipeline_ref');
      const body = refs ? await this.mergeRequests.existing(run, refs) : null;
      if (body) await this.documents.putDocument(run, 'merge_request', body);
    } catch (error) {
      this.logger.warn(`merge request of ${run.key} was not confirmed: ${String(error)}`);
    }
  }

  /** Whether the attempt's container runs. Null when docker stays silent through every probe. */
  private async probe(attemptId: string): Promise<boolean | null> {
    for (const wait of [...PROBE_BACKOFF_MS, null]) {
      const running = await this.sandbox.attemptRunning(attemptId);
      if (running !== null || wait === null) return running;
      await delay(wait);
    }
    return null;
  }

  /** Docker did not answer: the run is blocked and nothing new writes to it, until a Resume. */
  private async blocked(run: RunEntity): Promise<void> {
    await this.runs.release(run, {
      status: 'blocked',
      reason: { code: ERROR_CODES.RESOURCE_UNKNOWN, message: silentMessage(run.key) },
      stepStartedAt: null,
    });
  }

  /** The attempt ended without a visit: it gets one, through `finalize`, once. */
  private async recordInterrupted(run: RunEntity): Promise<void> {
    if (run.activeAttempt === null || !isStep(run.currentStep) || run.currentStep === 'done') return;
    const last = await this.events.lastOfAttempt(run.id, run.activeAttempt);
    if (last === null || last.kind === 'attempt.finished' || last.kind === 'attempt.interrupted') return;
    const scope = {
      runId: run.id,
      attemptId: run.activeAttempt,
      step: run.currentStep as StepName,
      root: this.root,
      clock: this.clock,
      sink: (event: Parameters<StepEventLog['append']>[0][number]) =>
        this.events.append([event]).catch((error: unknown) => {
          this.logger.warn(`event of ${run.key} was not stored: ${String(error)}`);
        }),
    };
    await runInStepScope(scope, await this.events.lastSeq(run.id), () => {
      recordStepEvent({ kind: 'attempt.interrupted', route: 'process died', summary: 'process died' });
      return Promise.resolve();
    });
  }

  /** The visit of an attempt whose process died, priced from what its output file holds. */
  private async interrupted(run: RunEntity, saved: string): Promise<void> {
    const now = this.clock.iso();
    const env = this.config.env;
    const agent = agentFor(env, run, run.currentStep);
    const model = agent?.model ?? null;
    const pricesOf = (runtime: Parameters<typeof loadPriceTable>[1]) =>
      loadPriceTable(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), runtime, this.clock.now());
    const step = isStep(run.currentStep) ? this.registry.get(run.currentStep) : null;
    const charge = step?.charge
      ? await step.charge(run.key, env, pricesOf, run.activeAttempt)
      : model
        ? chargeStream(model, saved, await pricesOf(agent?.runtime ?? env.RUNTIME))
        : null;
    run.spentUsd += charge?.usd ?? 0;
    writeRunState(run, { status: 'failed', ownerPid: null });
    const visit: VisitDraft = {
      step: run.currentStep,
      runtime: agent?.runtime ?? null,
      model,
      mode: null,
      startedAt: run.stepStartedAt ?? run.updatedAt,
      finishedAt: now,
      durationMs: elapsed(run.stepStartedAt, this.clock.now()),
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
      documents: [{ kind: 'error', fileName: '', body: 'process died\n' }],
      resumed: false,
    };
    await barrier('before-finalize');
    await this.visits.finalize(run.activeAttempt, run, visit);
    await barrier('after-finalize');
  }

  private get root(): string {
    return resolveRepoRoot(this.config.env.SWARMLOOP_ROOT, __dirname);
  }
}

/** When the run started to wait for the container of a dead owner. Null when it does not wait. */
function recoveringSince(run: RunEntity): number | null {
  if (run.state !== 'recovering' || !run.stateReason) return null;
  const since = Date.parse((JSON.parse(run.stateReason) as { message?: string }).message ?? '');
  return Number.isFinite(since) ? since : null;
}

function elapsed(startedAt: string | null, now: number): number {
  if (!startedAt) return 0;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}
