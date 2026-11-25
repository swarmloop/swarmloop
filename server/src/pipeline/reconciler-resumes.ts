import { Logger } from '@nestjs/common';
import type { ConnectionsService } from '../auth/connections.service';
import type { PersonalCredentials } from '../auth/personal-credentials.service';
import { agentsFor } from '../config/agents';
import type { AppConfig } from '../config/env';
import { ERROR_CODES } from '../contract/error-codes';
import { REASON } from '../contract/run-state';
import type { Clock } from '../core/clock';
import type { RunEntity } from '../history/entities';
import type { PlanChatStore } from '../history/plan-chat.store';
import type { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';
import type { RuntimeCooldownRepository } from '../history/runtime-cooldown.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { SandboxService } from '../sandbox/sandbox.service';
import { cooldownKeys } from '../steps/shared/limit-failover';
import { dockerWait } from '../steps/step-error-end';
import type { DiskGuard } from './disk-guard';
import type { StallWatch } from './stall-watch';
import type { StartGate } from './start-gate';
import type { SubtaskPort } from './subtask-port';

/** The passes of the reconciler that resume a run by themselves. Each resume goes through the start gate as the machine's. */
export class ReconcilerResumes {
  private readonly logger = new Logger(ReconcilerResumes.name);

  constructor(
    private readonly runs: RunRepository,
    private readonly sandbox: SandboxService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly gate: StartGate,
    private readonly cooldowns: RuntimeCooldownRepository,
    private readonly subtasks: SubtaskPort,
    private readonly disk: DiskGuard,
    private readonly visits: VisitRepository,
    private readonly stalls: StallWatch,
    /** Which runs a step of this process holds. */
    private readonly claimed: () => (key: string) => boolean,
    /** Settles a run that is `running` as if its process had just died. */
    private readonly reconcile: (run: RunEntity) => Promise<void>,
    private readonly connections?: ConnectionsService,
    private readonly credentials?: PersonalCredentials,
    private readonly planChat?: PlanChatStore,
    /** Takes a run's pending messages in the planner's turn, under the key of the outage it answers. */
    private readonly takeMessages?: (key: string, outage: string) => Promise<void>,
  ) {}

  /**
   * A run that waits for a provider limit goes on by itself, once, when an agent of its role is free again: at the
   * earliest end of the cooldowns of its runtimes, a minute after a reset the provider named.
   */
  async resumeLimited(): Promise<void> {
    for (const run of await this.runs.listRuns()) {
      if (run.status !== 'waiting' || storedState(run).reason?.code !== ERROR_CODES.RUNTIME_LIMIT) continue;
      try {
        const runtimes = agentsFor(this.config.env, run, run.currentStep).map((agent) => agent.runtime);
        const keys = await cooldownKeys(run, runtimes, this.runs, this.credentials);
        if (this.clock.now() < (await this.cooldowns.earliest(keys)).resumeAt) continue;
        await this.gate.resume(run, { by: 'machine', event: `limit-${run.revision}` });
      } catch (error) {
        this.logger.warn(`resume of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** A run that waits for a host goes on by itself, once, when the next try its reason names has come. */
  async resumeHostUnavailable(): Promise<void> {
    await this.resumeTimed(ERROR_CODES.HOST_UNAVAILABLE, 'host');
  }

  /**
   * A run no step of this process holds, and that is not running, takes its pending message again once the next try
   * of the model host wait the message carries has come. The key names the message and that try, so one outage is
   * taken once.
   */
  async resumeMessageHostWait(): Promise<void> {
    if (!this.planChat || !this.takeMessages) return;
    for (const run of await this.runs.listRuns()) {
      if (run.status === 'running' || this.claimed()(run.key)) continue;
      try {
        const [first] = await this.planChat.pending(run.key);
        const wait = first?.wait;
        if (!first || wait?.on !== 'model-host' || this.clock.now() < Date.parse(wait.retryAt)) continue;
        await this.takeMessages(run.key, `host-${first.key}-${wait.retryAt}`);
      } catch (error) {
        this.logger.warn(
          `message turn of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** A run whose CI did not start looks again, once, when the next look its reason names has come. */
  async resumeCiNotStarted(): Promise<void> {
    await this.resumeTimed(ERROR_CODES.CI_NOT_STARTED, 'ci');
  }

  private async resumeTimed(code: string, prefix: 'host' | 'ci'): Promise<void> {
    for (const run of await this.withReason('waiting', code)) {
      const retryAt = Date.parse(storedState(run).reason?.retryAt ?? '');
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
    const reason = storedState(run).reason;
    return `${prefix}-${attempt}-${(prefix === 'disk' ? reason?.message : reason?.retryAt) ?? ''}`;
  }

  private async withReason(status: string, code: string): Promise<RunEntity[]> {
    return (await this.runs.listRuns()).filter(
      (run) => run.status === status && storedState(run).reason?.code === code,
    );
  }

  /**
   * Resumes once under `key` when `ready` says so. A run a person stopped is refused by the gate.
   * Answers whether a new command was stored: false when not ready, replayed, refused, or failed.
   */
  private async resumeOnce(
    run: RunEntity,
    key: string,
    ready: () => Promise<boolean>,
    payload: Record<string, unknown> = {},
  ): Promise<boolean> {
    try {
      if (!(await ready())) return false;
      return (await this.gate.resume(run, { by: 'machine', event: key, payload })) === 'accepted';
    } catch (error) {
      this.logger.warn(`resume of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * A run idle with no reason is resumed after 15, 30 and 60 minutes, then handed to a person. The try is the
   * Resume a person gives; its key names the run, its attempt and the try, so a restart never sends one twice.
   */
  async resumeStalled(): Promise<void> {
    for (const { run, decision } of await this.stalls.decisions(this.claimed())) {
      try {
        if (decision.kind === 'person') {
          await this.stalls.askPerson(run, decision.reason);
        } else if (await this.resumeOnce(run, decision.key, () => Promise.resolve(true), decision.payload)) {
          await this.stalls.noteTry(run, decision);
        }
      } catch (error) {
        this.logger.warn(
          `stall of ${run.key} was not handled: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Docker is still silent: the next try moves forward. The run is read again, and only a run that still waits is written. */
  private async refreshDockerWait(key: string): Promise<void> {
    const run = await this.runs.findRun(key);
    if (run?.status !== 'waiting' || storedState(run).reason?.code !== ERROR_CODES.DOCKER_UNAVAILABLE) return;
    const { code, message, retryAt } = dockerWait(this.clock, this.config.env);
    writeRunState(run, { status: 'waiting', ownerPid: null, reason: { code, message, retryAt } });
    await this.runs.saveRun(run);
  }

  /** Docker answered: the run goes back to settling, as if its process had just died. */
  private async settleAnswered(key: string): Promise<void> {
    const run = await this.runs.findRun(key);
    if (run?.status !== 'waiting' || storedState(run).reason?.code !== ERROR_CODES.DOCKER_UNAVAILABLE) return;
    writeRunState(run, { status: 'running', ownerPid: null });
    await this.runs.saveRun(run);
    await this.reconcile(run);
  }

  /** A run that waits for a person to reconnect goes on by itself, once, when their connection is ok again. */
  async resumeGitAuth(): Promise<void> {
    for (const run of await this.runs.listRuns()) {
      if (run.status !== 'waiting' || storedState(run).reason?.code !== ERROR_CODES.GIT_AUTH) continue;
      try {
        if (!run.startedBy || !(await this.connections?.isHealthy(run.startedBy))) continue;
        await this.gate.resume(run, { by: 'machine', event: `git-auth-${run.revision}` });
      } catch (error) {
        this.logger.warn(`resume of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * A run whose step asked the planner goes on by itself after a restart: the resume takes the question to the planner.
   * The key names the question, so a question the planner could not settle is not resumed again and again.
   */
  async resumeAskingPlanner(): Promise<void> {
    for (const run of await this.withReason('waiting', REASON.asksPlanner)) {
      const [question] = (await this.planChat?.pendingQuestions(run.key)) ?? [];
      if (!question || this.claimed()(run.key)) continue;
      await this.resumeOnce(run, `planner-${question.key}`, () => Promise.resolve(true));
    }
  }

  /**
   * A run whose start was refused for its input goes on by itself after a restart: the resume asks the chain again, at
   * the level the question was at. The key names the open question, so one that nobody answers is not resumed again.
   */
  async resumeSameInput(): Promise<void> {
    for (const run of await this.withReason('waiting', REASON.sameInput)) {
      const question = await this.subtasks.openQuestion(run);
      if (!question || this.claimed()(run.key)) continue;
      await this.resumeOnce(run, `same-input-${question.key}`, () => Promise.resolve(true));
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
}
