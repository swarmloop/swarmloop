import type { OnModuleDestroy } from '@nestjs/common';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConnectionsService } from '../auth/connections.service';
import { AppConfig } from '../config/env';
import { PersonalCredentials } from '../auth/personal-credentials.service';
import { agentsFor } from '../config/agents';
import { ERROR_CODES } from '../contract/error-codes';
import { RunStop } from '../agent/run-stop';
import { Clock } from '../core/clock';
import { failedAttemptLaunches, loopMark } from '../core/pipeline-result';
import { AwakeTime } from '../core/awake-time';
import { SERVER_INSTANCE } from '../core/server-instance';
import type { RunEntity } from '../history/entities';
import { CommandRepository } from '../history/command.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { deriveState, writeRunState } from '../history/run-state';
import { VisitRepository } from '../history/visit.repository';
import { RuntimeCooldownRepository } from '../history/runtime-cooldown.repository';
import { DiskGuard } from './disk-guard';
import { dockerWait } from '../steps/step-error-end';
import { cooldownKeys } from '../steps/shared/limit-failover';
import { SandboxService } from '../sandbox/sandbox.service';
import { CHAT_LOCK, chatResume, readChatLock } from './chat-lock';
import { CommandService } from './command.service';
import { MergeWatch } from './merge-watch';
import { RunSettler } from './run-settler';
import { SubtaskPort } from './subtask-port';
import { settleShell } from './shell-lock';

export { silentMessage } from './run-settler';

/**
 * One idempotent look at the runs and commands that a process left behind. It runs at startup and every
 * `RECONCILE_MS`, one pass at a time: a call that comes while a pass works waits for it. A run it has settled is no longer `running`, so a second pass without new facts changes nothing.
 */
@Injectable()
export class Reconciler implements OnModuleDestroy {
  private readonly logger = new Logger(Reconciler.name);
  private claimed: (key: string) => boolean = () => false;
  private timer: NodeJS.Timeout | null = null;
  /** The pass in flight, or the last one queued. */
  private pass: Promise<void> | null = null;
  /** The pass a tick started, until it ends. A tick that finds it set does not queue another. */
  private tick: Promise<void> | null = null;
  private awake: AwakeTime | null = null;
  /** When the merge watch last ran. Null before its first pass. */
  private watchedAt: number | null = null;
  /** Host suspensions seen by the timer, so a wait that began before one does not count it. */
  private readonly slept: { at: number; ms: number }[] = [];

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly sandbox: SandboxService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly commands: CommandService,
    private readonly settler: RunSettler,
    private readonly cooldowns: RuntimeCooldownRepository,
    private readonly subtasks: SubtaskPort,
    private readonly mergeWatch: MergeWatch,
    private readonly disk: DiskGuard,
    private readonly commandLog: CommandRepository,
    private readonly visits: VisitRepository,
    private readonly runStop: RunStop,
    @Optional() private readonly connections?: ConnectionsService,
    @Optional() private readonly credentials?: PersonalCredentials,
  ) {}

  /** The startup pass over the runs. `claimed` says which runs a step of this process holds. */
  async start(claimed: (key: string) => boolean): Promise<void> {
    this.claimed = claimed;
    await this.exclusive(() => this.reconcileRunsNow());
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

  /** Stops the timer and waits for the pass that runs, so nothing reads the database after it closes. */
  async onModuleDestroy(): Promise<void> {
    this.stop();
    await this.pass?.catch(() => undefined);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A tick while an earlier tick's pass runs or waits is skipped. A failed tick is logged and the next one runs. */
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

  /** Runs `work` after the pass in flight has settled, whether it succeeded or failed. The caller sees its own result. */
  private exclusive(work: () => Promise<void>): Promise<void> {
    const previous = this.pass ?? Promise.resolve();
    const mine = previous.catch(() => undefined).then(work);
    const tail = mine.catch(() => undefined);
    this.pass = tail;
    void tail.then(() => {
      if (this.pass === tail) this.pass = null;
    });
    return mine;
  }

  reconcileAll(): Promise<void> {
    return this.exclusive(async () => {
      await this.reconcileRunsNow();
      await this.resumeLimited();
      await this.resumeHostUnavailable();
      await this.resumeCiNotStarted();
      await this.resumeDocker();
      await this.resumeDiskLow();
      await this.resumeGitAuth();
      await this.resumeSubtaskParents();
      await this.watchMerges();
      await this.reconcileCommands();
    });
  }

  reconcileRuns(): Promise<void> {
    return this.exclusive(() => this.reconcileRunsNow());
  }

  /** The runs in `running`, `stopping` or `recovering`: all three are a `running` status. */
  private async reconcileRunsNow(): Promise<void> {
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
        const keys = await cooldownKeys(run, runtimes, this.runs, this.credentials);
        if (this.clock.now() < (await this.cooldowns.earliest(keys)).resumeAt) continue;
        await this.commands.accept('resume', run.key, {}, { idempotencyKey: `limit-${run.revision}` });
      } catch (error) {
        this.logger.warn(`resume of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** A run that waits for a host goes on by itself, once, when the next try its reason names has come. */
  async resumeHostUnavailable(): Promise<void> {
    await this.resumeTimed(ERROR_CODES.HOST_UNAVAILABLE, 'host');
  }

  /** A run whose CI did not start looks again, once, when the next look its reason names has come. */
  async resumeCiNotStarted(): Promise<void> {
    await this.resumeTimed(ERROR_CODES.CI_NOT_STARTED, 'ci');
  }

  private async resumeTimed(code: string, prefix: 'host' | 'ci'): Promise<void> {
    for (const run of await this.withReason('waiting', code)) {
      const retryAt = Date.parse(deriveState(run).reason?.retryAt ?? '');
      if (Number.isFinite(retryAt) && this.clock.now() < retryAt) continue;
      await this.resumeOnce(run, await this.outageKey(prefix, run), () => Promise.resolve(true));
    }
  }

  /**
   * A run that waits for docker is probed on every tick and starts nothing while docker is silent. A run with its
   * attempt goes back to settling once docker answers; a run with none gets a resume.
   */
  async resumeDocker(): Promise<void> {
    for (const seen of await this.withReason('waiting', ERROR_CODES.DOCKER_UNAVAILABLE)) {
      try {
        if (seen.activeAttempt === null) {
          const answers = await this.sandbox.dockerAnswers();
          if (!answers) await this.refreshDockerWait(seen.key);
          else await this.resumeOnce(seen, await this.outageKey('docker', seen), () => Promise.resolve(true));
          continue;
        }
        const running = await this.sandbox.attemptRunning(seen.activeAttempt);
        if (running === null) await this.refreshDockerWait(seen.key);
        else await this.settleAnswered(seen.key);
      } catch (error) {
        this.logger.warn(
          `docker wait of ${seen.key} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** A run blocked for lack of disk goes on by itself, once, when the free space is above `MIN_FREE_GB`. Nothing is cleaned. */
  async resumeDiskLow(): Promise<void> {
    for (const run of await this.withReason('blocked', ERROR_CODES.DISK_LOW)) {
      await this.resumeOnce(run, await this.outageKey('disk', run), () => this.disk.hasFreeSpace());
    }
  }

  /** Names an outage by the attempt it cut and by its own retry time (or message), so another write to the run does not move it. */
  private async outageKey(prefix: 'host' | 'ci' | 'docker' | 'disk', run: RunEntity): Promise<string> {
    const stats = await this.visits.listStats(run.id);
    const attempt = stats[stats.length - 1]?.attemptId ?? 'none';
    const reason = deriveState(run).reason;
    return `${prefix}-${attempt}-${(prefix === 'disk' ? reason?.message : reason?.retryAt) ?? ''}`;
  }

  private async withReason(status: string, code: string): Promise<RunEntity[]> {
    return (await this.runs.listRuns()).filter(
      (run) => run.status === status && deriveState(run).reason?.code === code,
    );
  }

  /** Accepts one resume under `key` when `ready` says so. A stopped run is `blocked` with `STOPPED`, so it never gets here. */
  private async resumeOnce(run: RunEntity, key: string, ready: () => Promise<boolean>): Promise<void> {
    try {
      if (!(await ready())) return;
      await this.commands.accept('resume', run.key, {}, { idempotencyKey: key });
    } catch (error) {
      this.logger.warn(`resume of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Docker is still silent: the next try moves forward. The run is read again, and only a run that still waits is written. */
  private async refreshDockerWait(key: string): Promise<void> {
    const run = await this.runs.findRun(key);
    if (run?.status !== 'waiting' || deriveState(run).reason?.code !== ERROR_CODES.DOCKER_UNAVAILABLE) return;
    const { code, message, retryAt } = dockerWait(this.clock, this.config.env);
    writeRunState(run, { status: 'waiting', ownerPid: null, reason: { code, message, retryAt } });
    await this.runs.saveRun(run);
  }

  /** Docker answered: the run goes back to settling, as if its process had just died. */
  private async settleAnswered(key: string): Promise<void> {
    const run = await this.runs.findRun(key);
    if (run?.status !== 'waiting' || deriveState(run).reason?.code !== ERROR_CODES.DOCKER_UNAVAILABLE) return;
    writeRunState(run, { status: 'running', ownerPid: null });
    await this.runs.saveRun(run);
    await this.reconcile(run);
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
      if (!this.subtasks.passDue(run)) continue;
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
    if (await this.settler.settleRebase(run)) return;
    const stopping = (await this.commandLog.pending(run.id)).some((command) => command.type === 'stop');
    const deadAttempt = run.activeAttempt;
    await this.settler.settleAttempt(run, this.slept);
    if (!stopping) await this.relaunchInterrupted(run.key, deadAttempt);
  }

  /**
   * A step cut by a restart has its `process died` visit stored and its run `failed`. It is relaunched through the
   * resume a person would press, under the same `MAX_LAUNCHES` rule as the driver. A stopped run is not relaunched.
   * The key names the dead attempt, so two passes over it make one command and two attempts never share one.
   */
  private async relaunchInterrupted(key: string, deadAttempt: string | null): Promise<void> {
    if (deadAttempt === null) return;
    const run = await this.runs.findRun(key);
    if (run?.status !== 'failed' || run.currentStep === 'done' || this.runStop.halted(key)) return;
    const mark = loopMark(await this.documents.latestBody(key, 'loop_mark'));
    const stats = await this.visits.listStats(run.id);
    if (failedAttemptLaunches(stats, run.currentStep, mark, deadAttempt) >= this.config.env.MAX_LAUNCHES) return;
    await this.resumeOnce(run, `relaunch-${deadAttempt}`, () => Promise.resolve(true));
  }

  /** The owner is this process and its step is in flight, or a chat of this process holds the run. */
  private ownedHere(run: RunEntity, chatPid: number | undefined): boolean {
    const chat = chatPid !== undefined && chatPid === run.ownerPid && run.ownerPid === process.pid;
    return chat || (run.ownerInstance === SERVER_INSTANCE && this.claimed(run.key));
  }
}
