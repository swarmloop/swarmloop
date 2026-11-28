import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PersonalCredentials } from '../auth/personal-credentials.service';
import { AppConfig } from '../config/env';
import { missingCredential, runAgents } from '../config/agents';
import type { StoredAgents } from '../contract/api';
import type { CommandEntity, RunEntity } from '../history/entities';
import { CommandRepository, conflict } from '../history/command.repository';
import { UserSettingRepository } from '../history/user-setting.repository';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { readParkedConflict } from './parked-conflict';
import { stateOfStatus, storedState } from '../history/run-state';
import { actionsFor, SKIPPED_NOTE } from '../contract/run-state';
import type { CommandReceipt, CommandType, CommandView } from '../contract/command';
import { barrier } from '../core/barrier';
import { assertKey } from '../core/pipeline-result';
import type { PipelineResult } from '../core/pipeline-result';
import { isHostOutage, SwarmloopError } from '../core/swarmloop-error';
import { RunStop } from '../agent/run-stop';
import { CommandOutcomes } from './command-outcomes';
import { commandView } from './command-view';
import { LiveHub } from '../live/live.hub';

interface CommandContext {
  commandId: string;
  /** The login of the person who asked; null for the server's own commands. */
  actor: string | null;
}

/** Runs a command against the run. The services that did the work before the command path are the handlers. */
export type CommandHandler = (
  key: string,
  payload: Record<string, unknown>,
  context: CommandContext,
) => Promise<unknown>;

export interface SubmitOptions {
  idempotencyKey?: string;
  expectedRevision?: number;
  create?: { targetPath: string | null; startedBy?: string | null; agents?: StoredAgents | null };
  /** The person who asks. Resume, replay and rebase by a person take over a run recorded as machine. */
  actor?: string | null;
  /** Runs this command in this process instead of the registered handler. The CLI uses it. */
  run?: CommandHandler;
}

/** The commands that make their person the owner of a run that was recorded as machine. */
const TAKEOVER_TYPES: readonly CommandType[] = ['resume', 'replay', 'rebase'];

/** A command that is accepted while a writer holds the run is refused. */
const BUSY_TYPES: readonly CommandType[] = ['start', 'resume', 'rebase', 'answer'];

/**
 * The one door to a run. `accept` checks the transition and stores the command in one short transaction.
 * The executor then runs the commands of a run one at a time, except a Stop: it is the interrupt.
 */
@Injectable()
export class CommandService {
  private readonly logger = new Logger(CommandService.name);
  private readonly handlers = new Map<CommandType, CommandHandler>();
  private readonly inline = new Map<string, CommandHandler>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly scheduled = new Set<string>();
  private readonly stops = new Set<Promise<void>>();
  private readonly outcomes: CommandOutcomes;

  constructor(
    private readonly commands: CommandRepository,
    private readonly runs: RunRepository,
    private readonly runStop: RunStop,
    private readonly config: AppConfig,
    private readonly credentials: PersonalCredentials,
    private readonly userSettings: UserSettingRepository,
    private readonly documents: DocumentRepository,
    @Optional() private readonly live?: LiveHub,
  ) {
    this.outcomes = new CommandOutcomes(commands);
  }

  register(type: CommandType, handler: CommandHandler): void {
    this.handlers.set(type, handler);
  }

  /** Stores the command and wakes the executor. */
  async accept(
    type: CommandType,
    key: string,
    payload: Record<string, unknown>,
    options: SubmitOptions = {},
  ): Promise<{ command: CommandEntity; run: RunEntity; replayed: boolean }> {
    const current = await this.runs.findRun(key);
    if (!current && options.create) {
      await this.assertCredentials(options.create);
    }
    const parked = await this.parkedOf(type, current, !options.run);
    const accepted = await this.commands.accept({
      type,
      key,
      payload,
      idempotencyKey: options.idempotencyKey,
      expectedRevision: options.expectedRevision,
      create: options.create,
      actor: options.actor,
      takeOver: await this.takeOverOf(type, options.actor),
      admit: (run) => this.admit(type, key, run, !options.run, parked),
    });
    this.runs.notify(key);
    await barrier('after-accept');
    if (accepted.command.state === 'accepted') {
      if (options.run) this.inline.set(accepted.command.id, options.run);
      this.schedule(accepted.command, key);
    }
    return accepted;
  }

  /** Stores a command of no run, queued under its scope, and wakes the executor. It moves no run. */
  async acceptScoped(
    type: CommandType,
    scope: string,
    payload: Record<string, unknown>,
    options: { idempotencyKey?: string; actor?: string | null } = {},
  ): Promise<CommandEntity> {
    const { command } = await this.commands.acceptScoped({ type, scope, payload, ...options });
    if (command.state === 'accepted') this.schedule(command, scope);
    return command;
  }

  /** The command for the person who asked it; null when it is missing or another person's (both null with sign-in off). */
  async view(id: string, actor: string | null): Promise<CommandView | null> {
    const stored = await this.commands.find(id);
    return stored && stored.actor === actor ? commandView(stored) : null;
  }

  /** The newest command of a run whose idempotency key starts with `prefix`: the record of the last try of an event. */
  latestByKeyPrefix(runId: number, prefix: string): Promise<CommandEntity | null> {
    return this.commands.latestByKeyPrefix(runId, prefix);
  }

  /** The commands of a run, whatever their type, in the order they were created, then stored. */
  listForRun(runId: number): Promise<CommandEntity[]> {
    return this.commands.listForRun(runId);
  }

  /** Whether a blocked run's Resume is checked against a conflict parked for implement, read before the transaction. */
  private async parkedOf(type: CommandType, run: RunEntity | null, checked: boolean): Promise<boolean> {
    if (type !== 'resume' || !checked || !run || storedState(run).state !== 'blocked') return false;
    return readParkedConflict(this.documents, run);
  }

  private async takeOverOf(type: CommandType, actor: string | null | undefined) {
    if (!actor || !TAKEOVER_TYPES.includes(type)) return undefined;
    return { login: actor, agents: (await this.userSettings.read(actor))?.agents ?? null };
  }

  /** A new run starts only when every agent it can use has a credential for its starter: theirs, else the server's. */
  private async assertCredentials(create: NonNullable<SubmitOptions['create']>): Promise<void> {
    for (const { runtime } of runAgents(this.config.env, { agents: create.agents })) {
      if (!(await this.credentials.runtimeCredential(runtime, create.startedBy ?? null))) {
        throw new UnprocessableEntityException(missingCredential(runtime));
      }
    }
  }

  /** Accepts the command and answers with what the handler returned, as the route did before. */
  async submit<T>(
    type: CommandType,
    key: string,
    payload: Record<string, unknown>,
    options: SubmitOptions = {},
  ): Promise<{ value: T; receipt: CommandReceipt }> {
    const { command, run } = await this.accept(type, key, payload, options);
    const outcome = await this.outcomes.outcome(command);
    if (!outcome.ok) {
      throw outcome.error;
    }
    const after = (await this.runs.findRun(key)) ?? run;
    return {
      value: outcome.value as T,
      receipt: { commandId: command.id, revision: after.revision, state: storedState(after).state },
    };
  }

  /** The command path for the CLI: the command runs in this process and answers like the pipeline did. */
  async inProcess(
    type: CommandType,
    key: string,
    payload: Record<string, unknown>,
    run: () => Promise<PipelineResult>,
    person?: { login: string; agents: StoredAgents | null },
  ): Promise<PipelineResult> {
    try {
      assertKey(key);
    } catch (error) {
      return { exitCode: 1, message: error instanceof Error ? error.message : 'key is invalid' };
    }
    try {
      const { value } = await this.submit<PipelineResult>(type, key, payload, {
        create: { targetPath: null, ...(person ? { startedBy: person.login, agents: person.agents } : {}) },
        actor: person?.login,
        run,
      });
      return value;
    } catch (error) {
      if (error instanceof HttpException) {
        return { exitCode: 1, message: error.message };
      }
      throw error;
    }
  }

  /** Resolves when every command accepted so far has run. */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values(), ...this.stops]);
  }

  /**
   * Settles the commands a process left behind. A Stop is kept: its run is halted and it runs again. Another
   * executing command is settled from the facts, an accepted one runs. A command this process holds is left alone.
   */
  async recover(): Promise<void> {
    for (const key of await this.commands.stoppingKeys()) this.runStop.halt(key);
    for (const command of await this.commands.listExecuting()) {
      if (this.scheduled.has(command.id)) continue;
      await this.settleLost(command);
    }
    for (const command of await this.commands.listAccepted()) {
      const key = await this.commands.keyOf(command);
      if (key) this.schedule(command, key);
    }
  }

  /** Runs the accepted commands of one run, such as a relaunch stored with a visit. A command this process holds is left alone. */
  async runAccepted(key: string): Promise<void> {
    const run = await this.runs.findRun(key);
    if (!run) return;
    for (const command of await this.commands.pending(run.id)) {
      if (command.state === 'accepted') this.schedule(command, key);
    }
  }

  /**
   * A command a dead process took: a Stop, a Remove and a Rebase run again (each can be repeated: the journal resumes
   * a half-done rebase, its push is by lease and each subtask move is keyed by the tip), a command whose run is done
   * is confirmed, any other is failed.
   */
  private async settleLost(command: CommandEntity): Promise<void> {
    if (command.runId === null) {
      await this.commands.finish(command.id, 'failed', { error: { message: 'server restarted' } });
      this.ended(command, null, 'failed');
      return;
    }
    if (command.type === 'stop' || command.type === 'remove' || command.type === 'rebase') {
      await this.commands.requeue(command.id);
      return;
    }
    const key = await this.commands.keyOf(command);
    const run = key ? await this.runs.findRun(key) : null;
    if (run?.status === 'done') {
      await this.commands.finish(command.id, 'succeeded', { value: null });
    } else {
      await this.commands.finish(command.id, 'failed', { error: { message: 'server restarted' } });
    }
    this.ended(command, key, run?.status === 'done' ? 'succeeded' : 'failed');
  }

  /** Tells whoever shows the command that it ended: the run's readers for a run command, the sockets for a command of no run. */
  private ended(command: CommandEntity, key: string | null, state: 'succeeded' | 'failed'): void {
    if (command.runId === null) this.live?.commandEnded({ commandId: command.id, state });
    else if (key) this.runs.notify(key);
  }

  /** `checked` is true for an HTTP command: its Resume is checked against the block's stored code. The CLI's run never refused a block. */
  private admit(
    type: CommandType,
    key: string,
    run: RunEntity | null,
    checked: boolean,
    parkedConflict: boolean,
  ): void {
    if (!run) return;
    const held = this.runs.held(run);
    if (type !== 'remove' && storedState(run).state === 'skipped') {
      throw new ConflictException(SKIPPED_NOTE);
    }
    if (BUSY_TYPES.includes(type) && held) {
      throw conflict('RUN_BUSY', `${key} is already running`, run, 'running');
    }
    const status = run.status === 'running' && !held ? 'failed' : run.status;
    const state = storedState({
      ...run,
      ...stateOfStatus({ status, stateReason: run.stateReason }),
    });
    if (
      type === 'resume' &&
      checked &&
      state.state === 'blocked' &&
      !actionsFor(state.state, state.reason?.code ?? null, { parkedConflict }).includes('resume')
    ) {
      throw new ConflictException({
        statusCode: 409,
        message: 'run is blocked',
        error: 'Conflict',
        state: state.state,
        revision: run.revision,
      });
    }
  }

  private schedule(command: CommandEntity, key: string): void {
    if (this.scheduled.has(command.id)) return;
    this.scheduled.add(command.id);
    const tail = command.type === 'stop' ? Promise.resolve() : (this.queues.get(key) ?? Promise.resolve());
    const next = tail.then(() => this.execute(command, key));
    if (command.type !== 'stop') {
      this.queues.set(key, next);
      return;
    }
    this.stops.add(next);
    void next.finally(() => this.stops.delete(next));
  }

  private async execute(command: CommandEntity, key: string): Promise<void> {
    try {
      if (!(await this.commands.start(command.id))) {
        this.outcomes.settle(command.id, { ok: false, error: new ConflictException(`${key} command was superseded`) });
        return;
      }
      const handler = this.inline.get(command.id) ?? this.handlers.get(command.type as CommandType);
      if (!handler) {
        throw new SwarmloopError(`${command.type} has no handler`);
      }
      const payload = JSON.parse(command.payload) as Record<string, unknown>;
      const value = await handler(key, payload, { commandId: command.id, actor: command.actor });
      await this.commands.finish(command.id, 'succeeded', { value });
      this.ended(command, key, 'succeeded');
      this.outcomes.settle(command.id, { ok: true, value });
    } catch (error) {
      this.logger.warn(`${command.type} of ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.commands
        .finish(command.id, 'failed', {
          error: {
            message: error instanceof Error ? error.message : String(error),
            // The time of the next automatic try, so a caller that waits for an outage knows when to ask again.
            ...(isHostOutage(error) ? { code: error.code, retryAt: error.retryAt } : {}),
          },
        })
        .catch(() => undefined);
      this.ended(command, key, 'failed');
      this.outcomes.settle(command.id, { ok: false, error });
    } finally {
      this.inline.delete(command.id);
      this.scheduled.delete(command.id);
    }
  }
}
