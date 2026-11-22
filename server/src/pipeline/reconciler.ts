import type { OnModuleDestroy } from '@nestjs/common';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConnectionsService } from '../auth/connections.service';
import { AppConfig } from '../config/env';
import { PersonalCredentials } from '../auth/personal-credentials.service';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunStop } from '../agent/run-stop';
import { markedInterval } from '../core/entered-marks';
import { Clock } from '../core/clock';
import { failedAttemptLaunches, loopMark } from '../core/pipeline-result';
import { AwakeTime } from '../core/awake-time';
import { SERVER_INSTANCE } from '../core/server-instance';
import type { RunEntity, StepStatEntity } from '../history/entities';
import { CommandRepository } from '../history/command.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { RuntimeCooldownRepository } from '../history/runtime-cooldown.repository';
import { DiskGuard } from './disk-guard';
import { SandboxService } from '../sandbox/sandbox.service';
import { CHAT_LOCK, readChatLock } from './chat-lock';
import { CommandService } from './command.service';
import { MergeWatch } from './merge-watch';
import { RunSettler, relaunchKey, type RelaunchDecision } from './run-settler';
import { StallWatch } from './stall-watch';
import { StoppedCleanup } from './stopped-cleanup';
import { ReconcilerResumes } from './reconciler-resumes';
import { StartGate } from './start-gate';
import { SubtaskPort } from './subtask-port';
import { settleChat, settleShell } from './shell-lock';

export { silentMessage } from './run-settler';

/**
 * One idempotent look at the runs and commands that a process left behind. It runs at startup and every
 * `RECONCILE_MS`, one pass at a time: a call that comes while a pass works waits for it. A run it has settled is no longer `running`, so a second pass without new facts changes nothing.
 */
@Injectable()
export class Reconciler implements OnModuleDestroy {
  private readonly logger = new Logger(Reconciler.name);
  private readonly resumes: ReconcilerResumes;
  private readonly cleanup: StoppedCleanup;
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
    cooldowns: RuntimeCooldownRepository,
    subtasks: SubtaskPort,
    private readonly mergeWatch: MergeWatch,
    disk: DiskGuard,
    private readonly commandLog: CommandRepository,
    private readonly visits: VisitRepository,
    private readonly runStop: RunStop,
    stalls: StallWatch,
    gate: StartGate,
    @Optional() connections?: ConnectionsService,
    @Optional() credentials?: PersonalCredentials,
    @Optional() planChat?: PlanChatStore,
  ) {
    this.cleanup = new StoppedCleanup(runs, documents, sandbox, config);
    this.resumes = new ReconcilerResumes(
      runs,
      sandbox,
      config,
      clock,
      gate,
      cooldowns,
      subtasks,
      disk,
      visits,
      stalls,
      () => this.claimed,
      (run) => this.reconcile(run),
      connections,
      credentials,
      planChat,
    );
  }

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
    this.timer = markedInterval('reconciler pass', () => this.tickOnce(), this.config.env.RECONCILE_MS);
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
      await this.cleanup.run();
      await this.settleEndedRelaunches();
      await this.resumeLimited();
      await this.resumeHostUnavailable();
      await this.resumeCiNotStarted();
      await this.resumeDocker();
      await this.resumeDiskLow();
      await this.resumeGitAuth();
      await this.resumeSubtaskParents();
      await this.resumeStalled();
      await this.resumeAskingPlanner();
      await this.resumeSameInput();
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

  /** See `ReconcilerResumes`. */
  resumeLimited(): Promise<void> {
    return this.resumes.resumeLimited();
  }

  resumeHostUnavailable(): Promise<void> {
    return this.resumes.resumeHostUnavailable();
  }

  resumeCiNotStarted(): Promise<void> {
    return this.resumes.resumeCiNotStarted();
  }

  resumeDocker(): Promise<void> {
    return this.resumes.resumeDocker();
  }

  resumeDiskLow(): Promise<void> {
    return this.resumes.resumeDiskLow();
  }

  resumeStalled(): Promise<void> {
    return this.resumes.resumeStalled();
  }

  resumeGitAuth(): Promise<void> {
    return this.resumes.resumeGitAuth();
  }

  resumeAskingPlanner(): Promise<void> {
    return this.resumes.resumeAskingPlanner();
  }

  resumeSameInput(): Promise<void> {
    return this.resumes.resumeSameInput();
  }

  resumeSubtaskParents(): Promise<void> {
    return this.resumes.resumeSubtaskParents();
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
    if (await settleChat(this.runs, this.documents, run, body)) return;
    if (await this.settler.settleRebase(run)) return;
    const deadAttempt = run.activeAttempt;
    const decision = await this.settler.settleAttempt(run, this.slept, () => this.relaunchDecision(run, deadAttempt));
    if (decision?.relaunch) await this.commands.runAccepted(run.key);
  }

  /**
   * Whether the attempt a restart cut is started again, under the same `MAX_LAUNCHES` rule as the driver. A run with
   * a Stop pending or halted is not. The key names the dead attempt, so two passes over it make one command and two
   * attempts never share one.
   */
  private async relaunchDecision(run: RunEntity, deadAttempt: string | null): Promise<RelaunchDecision> {
    const stopped =
      (await this.commandLog.pending(run.id)).some((command) => command.type === 'stop') ||
      this.runStop.halted(run.key);
    if (stopped) return { relaunch: false, cause: 'stop' };
    if (deadAttempt === null || run.currentStep === 'done') return { relaunch: false, cause: null };
    const mark = loopMark(await this.documents.latestBody(run.key, 'loop_mark'));
    const stats = await this.visits.listStats(run.id);
    if (failedAttemptLaunches(stats, run.currentStep, mark, deadAttempt) >= this.config.env.MAX_LAUNCHES) {
      return { relaunch: false, cause: 'limit' };
    }
    return { relaunch: true, idempotencyKey: relaunchKey(deadAttempt) };
  }

  /**
   * A relaunch stored with a cut visit can end before its step takes the run: it failed, a Stop took its place, or
   * the server stopped again. Nothing would start such a run, so it is saved as a run nobody relaunches. A run is
   * left alone while a command of it is pending or a step of this process holds it, and when it moved since it was read.
   */
  async settleEndedRelaunches(): Promise<void> {
    const idle = (await this.runs.listRuns()).filter(
      (run) => run.status === 'waiting' && run.stateReason === null && run.activeAttempt === null,
    );
    const latest = await this.visits.latestVisits(idle.map((run) => run.id));
    for (const run of idle) {
      const cut = latest.get(run.id);
      if (cut?.killReason !== 'process died') continue;
      try {
        await this.settleEndedRelaunch(run, cut);
      } catch (error) {
        this.logger.warn(
          `relaunch of ${run.key} was not settled: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async settleEndedRelaunch(
    run: RunEntity,
    cut: Pick<StepStatEntity, 'id' | 'attemptId' | 'finishedAt'>,
  ): Promise<void> {
    if (cut.attemptId === null) return;
    const stored = await this.commandLog.listForRun(run.id);
    const relaunch = stored.find((command) => command.idempotencyKey === relaunchKey(cut.attemptId!));
    const pending = stored.some(
      (command) => command.type !== 'stop' && ['accepted', 'executing'].includes(command.state),
    );
    // The claim is read after the commands: a start that finished in between is still held by this process.
    if (!relaunch || pending || this.claimed(run.key)) return;
    await this.settler.endRelaunch(run, cut, relaunch);
  }

  /** The owner is this process and its step is in flight, or a chat of this process holds the run. */
  private ownedHere(run: RunEntity, chatPid: number | undefined): boolean {
    const chat = chatPid !== undefined && chatPid === run.ownerPid && run.ownerPid === process.pid;
    return chat || (run.ownerInstance === SERVER_INSTANCE && this.claimed(run.key));
  }
}
