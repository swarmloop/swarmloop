import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { agentFor } from '../config/agents';
import { resolveRepoRoot } from '../config/repo-root';
import { ERROR_CODES } from '../contract/error-codes';
import type { InterruptionNote } from '../contract/interruption';
import { REASON, type StateReason } from '../contract/run-state';
import type { StepName } from '../contract/steps';
import { hasFinalResult, knownAttempts, stepOutput } from '../core/attempt-output';
import { barrier } from '../core/barrier';
import { Clock } from '../core/clock';
import { delay } from '../core/delay';
import { isHostOutage } from '../core/swarmloop-error';
import { isStep } from '../core/pipeline-result';
import { recordStepEvent, runInStepScope } from '../core/step-event-scope';
import type { CommandEntity, RunEntity, StepStatEntity } from '../history/entities';
import { figuresOf } from '../history/agent-call';
import { AgentCallRepository } from '../history/agent-call.repository';
import { CommandRepository } from '../history/command.repository';
import { CheckCommandRepository } from '../history/check-command.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { recoveringSince, writeRunState } from '../history/run-state';
import { StepEventLog } from '../history/step-event.log';
import type { VisitDraft } from '../history/visit';
import { VisitRepository } from '../history/visit.repository';
import { SandboxService } from '../sandbox/sandbox.service';
import { fingerprintOf, parseJournal, unfinished, REBASE_JOURNAL } from '../git/rebase';
import { MergeRequestLookup } from '../steps/merge-request/merge-request-lookup';
import { RunRebase } from '../steps/run-rebase';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { dockerWait } from '../steps/step-error-end';
import { AttemptStream } from './attempt-stream';
import { WorkspaceGuard, workspaceBlock } from './workspace-guard';

/** Waits between the read-only probes of a docker that does not answer. */
const PROBE_BACKOFF_MS = [1_000, 2_000];

/** Whether a cut attempt is started again. The one decision, made by the reconciler. */
export type RelaunchDecision =
  { relaunch: true; idempotencyKey: string } | { relaunch: false; cause: 'limit' | 'stop' | null };

/** The key of the relaunch command of a cut attempt. It names the attempt, so two passes over it store one command. */
export function relaunchKey(attemptId: string): string {
  return `relaunch-${attemptId}`;
}

/** Settles what a dead process left in a run: an unfinished rebase journal or an attempt without its visit. */
@Injectable()
export class RunSettler {
  private readonly logger = new Logger(RunSettler.name);

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly visits: VisitRepository,
    private readonly sandbox: SandboxService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly events: StepEventLog,
    private readonly mergeRequests: MergeRequestLookup,
    private readonly rebases: RunRebase,
    private readonly workspace: WorkspaceGuard,
    private readonly checkCommands: CheckCommandRepository,
    private readonly calls: AgentCallRepository,
    private readonly launcher: AgentLauncher,
    private readonly stream: AttemptStream,
    private readonly commands: CommandRepository,
  ) {}

  /**
   * A journal below `completed` is read before the run continues or blocks. Files that no longer match the last
   * checkpoint block it with `REBASE_CONFLICT`; otherwise the rebase resumes through `RunRebase`, without a new
   * generation. A repo in `conflict` waits for a person, so it is neither. A run with a rebase command still to run
   * is left to that command, which resumes the same journal.
   */
  async settleRebase(run: RunEntity): Promise<boolean> {
    if ((await this.commands.pending(run.id)).some((command) => command.type === 'rebase')) return false;
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
    const before = { status: run.status, reason: run.stateReason, stepStartedAt: run.stepStartedAt };
    const released = await this.runs.release(run, { status: 'failed', stepStartedAt: null });
    try {
      await this.rebases.rebase(run.key, true);
    } catch (error) {
      if (isHostOutage(error)) {
        this.logger.warn(`rebase of ${run.key} waits for the host: ${error.message}`);
        await this.runs.release(released, {
          status: before.status,
          reason: before.reason ? (JSON.parse(before.reason) as StateReason) : null,
          stepStartedAt: before.stepStartedAt,
        });
        return true;
      }
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

  /**
   * `slept` holds the host suspensions the reconciler's timer saw, taken off the wait for a container. `decide` is
   * called once, after everything that takes time (the probes, the kill, the charge) and right before the visit is
   * written, so a Stop that came while the attempt was settled is seen. Its answer is applied in the same
   * transaction: a relaunch leaves the run `waiting` with the `resume` command stored, anything else leaves it
   * `failed`. Returns the decision it applied, or null when it stored no visit.
   *
   * The one place that decides whether to wait for a container a dead process left: the run waits `RECOVER_WAIT_MS`
   * only while a running container of the attempt can still give its result after the restart. A container whose
   * result is lost is stopped at once and the attempt is settled with no wait.
   */
  async settleAttempt(
    run: RunEntity,
    slept: readonly { at: number; ms: number }[],
    decide: () => Promise<RelaunchDecision>,
  ): Promise<RelaunchDecision | null> {
    const known = knownAttempts(run.activeAttempt, await this.visits.listStats(run.id));
    const output = stepOutput(this.root, run.key, run.currentStep, run.activeAttempt, known);
    if (hasFinalResult(output)) {
      await this.recordInterrupted(run);
      return this.interrupted(run, decide);
    }
    const attemptId = run.activeAttempt;
    const container = attemptId === null ? false : await this.probe(attemptId);
    if (container === null) {
      await this.blocked(run);
      return null;
    }
    const awaited = container ? await this.sandbox.attemptAwaited(attemptId!) : false;
    if (awaited === null) {
      await this.blocked(run);
      return null;
    }
    if (container && !awaited) {
      if (!(await this.sandbox.killAttempt(attemptId!))) {
        await this.blocked(run);
        return null;
      }
    } else if (container) {
      const since = recoveringSince(run);
      if (since === null) {
        await this.runs.change(run.key, (row) => {
          writeRunState(row, {
            status: 'running',
            ownerPid: null,
            reason: { code: REASON.recovering, message: this.clock.iso() },
            facts: { recovering: true },
          });
        });
        return null;
      }
      const asleep = slept.filter((gap) => gap.at > since).reduce((sum, gap) => sum + gap.ms, 0);
      if (this.clock.now() - since - asleep < this.config.env.RECOVER_WAIT_MS) return null;
      if (!(await this.sandbox.killAttempt(attemptId!))) {
        await this.blocked(run);
        return null;
      }
    }
    if (run.currentStep === 'merge-request') await this.confirmMergeRequest(run);
    await this.recordInterrupted(run);
    return this.interrupted(run, decide);
  }

  /**
   * The relaunch stored with a cut visit ended before its step took the run. The run is saved as one nobody
   * relaunches, `failed`, and the note of the visit says so: a Stop took the place of the command, or the start
   * did not go through. A run that moved since it was read is left as it is.
   */
  async endRelaunch(
    run: RunEntity,
    cut: Pick<StepStatEntity, 'id' | 'finishedAt'>,
    relaunch: CommandEntity,
  ): Promise<void> {
    const cause = relaunch.state === 'superseded' ? 'stop' : 'start';
    writeRunState(run, { status: 'failed', ownerPid: null });
    const note: InterruptionNote = { at: cut.finishedAt, relaunched: false, cause };
    // The write bypassed `change`: the dashboard is told that the run left `queued`.
    if (await this.visits.endRelaunch(run, cut, note, this.clock.iso())) this.runs.notify(run.key);
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

  /** Docker did not answer: the run waits with its attempt, nothing starts, and the reconciler probes again. */
  private async blocked(run: RunEntity): Promise<void> {
    const { code, message, retryAt } = dockerWait(this.clock, this.config.env);
    await this.runs.change(run.key, (row) => {
      writeRunState(row, { status: 'waiting', ownerPid: null, reason: { code, message, retryAt } });
      row.stepStartedAt = null;
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
    await runInStepScope(scope, () => {
      recordStepEvent({ kind: 'attempt.interrupted', route: 'process died', summary: 'process died' });
      return Promise.resolve();
    });
  }

  /**
   * The visit of an attempt whose process died, charged with what the log holds for the attempt: the streamed cost
   * of its rows that no stored visit holds yet, and the requests its output files hold that no server read. The run
   * is saved with it: `waiting` with the relaunch command when the decision says so, else `failed`. The decision is
   * taken after the charge, the last thing that takes time here.
   */
  private async interrupted(run: RunEntity, decide: () => Promise<RelaunchDecision>): Promise<RelaunchDecision> {
    const now = this.clock.iso();
    const agent = agentFor(this.config.env, run, run.currentStep);
    const model = agent?.model ?? null;
    if (run.activeAttempt !== null) {
      await this.launcher.closeLeftOpen({ attemptId: run.activeAttempt });
      for (const streamed of await this.stream.read(run, (step) =>
        stepOutput(this.root, run.key, step, run.activeAttempt),
      )) {
        await this.launcher.countStream(streamed.subject, streamed.agent, streamed.requests);
      }
    }
    const rows = run.activeAttempt === null ? [] : await this.calls.rowsOfAttempt(run.activeAttempt);
    const charge = figuresOf(rows);
    run.spentUsd += charge.usd;
    const decision = await decide();
    writeRunState(
      run,
      decision.relaunch ? { status: 'waiting', ownerPid: null } : { status: 'failed', ownerPid: null },
    );
    const note = this.noteOf(decision, now);
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
      tokensIn: charge.tokensIn,
      tokensOut: charge.tokensOut,
      usd: charge.usd,
      samples: [],
      callIds: rows.map((row) => row.id),
      httpCalls: [],
      document: null,
      documents: [
        { kind: 'error', fileName: '', body: 'process died\n' },
        ...(note ? [{ kind: 'interruption', fileName: '', body: JSON.stringify(note) }] : []),
      ],
      resumed: false,
    };
    await barrier('before-finalize');
    if (run.activeAttempt) await this.checkCommands.closeOpen(run.activeAttempt, now);
    const command = decision.relaunch
      ? { type: 'resume' as const, payload: {}, idempotencyKey: decision.idempotencyKey, now }
      : undefined;
    await this.visits.finalize(run.activeAttempt, run, visit, command);
    await barrier('after-finalize');
    return decision;
  }

  /** The note that says what the decision does with the cut attempt. Null when there is no decision to tell. */
  private noteOf(decision: RelaunchDecision, at: string): InterruptionNote | null {
    if (decision.relaunch) return { at, relaunched: true };
    if (decision.cause === 'limit') {
      return { at, relaunched: false, cause: 'limit', limit: this.config.env.MAX_LAUNCHES };
    }
    return decision.cause === 'stop' ? { at, relaunched: false, cause: 'stop' } : null;
  }

  private get root(): string {
    return resolveRepoRoot(this.config.env.SWARMLOOP_ROOT, __dirname);
  }
}

function elapsed(startedAt: string | null, now: number): number {
  if (!startedAt) return 0;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}
