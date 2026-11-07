import { ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';
import type { CommandEntity, RunEntity } from '../history/entities';
import { CommandRepository, conflict } from '../history/command.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { blockCode, deriveState } from '../history/run-state';
import { actionsFor } from '../contract/run-state';
import type { CommandReceipt, CommandType } from '../contract/command';
import { assertKey } from '../core/pipeline-result';
import type { PipelineResult } from '../core/pipeline-result';
import { SwarmloopError } from '../core/swarmloop-error';
import { RunStop } from '../agent/run-stop';

interface CommandContext {
  commandId: string;
  /** This command created the run. */
  created: boolean;
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
  create?: { targetPath: string | null };
  /** Runs this command in this process instead of the registered handler. The CLI uses it. */
  run?: CommandHandler;
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** A command that is accepted while a writer holds the run is refused. */
const BUSY_TYPES: readonly CommandType[] = ['start', 'resume', 'rebase', 'answer', 'chat'];

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
  private readonly waiters = new Map<string, ((outcome: Outcome) => void)[]>();

  constructor(
    private readonly commands: CommandRepository,
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly runStop: RunStop,
  ) {}

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
    const error = current?.status === 'blocked' ? await this.documents.latestBody(key, 'error') : null;
    const code = current?.status === 'blocked' ? blockCode(current.currentStep, error) : null;
    const accepted = await this.commands.accept({
      type,
      key,
      payload,
      idempotencyKey: options.idempotencyKey,
      expectedRevision: options.expectedRevision,
      create: options.create,
      admit: (run) => this.admit(type, key, run, options.run ? null : code),
    });
    if (accepted.command.state === 'accepted') {
      if (options.run) this.inline.set(accepted.command.id, options.run);
      this.schedule(accepted.command, key);
    }
    return accepted;
  }

  /** Accepts the command and answers with what the handler returned, as the route did before. */
  async submit<T>(
    type: CommandType,
    key: string,
    payload: Record<string, unknown>,
    options: SubmitOptions = {},
  ): Promise<{ value: T; receipt: CommandReceipt }> {
    const { command, run } = await this.accept(type, key, payload, options);
    const outcome = await this.outcome(command);
    if (!outcome.ok) {
      throw outcome.error;
    }
    const after = (await this.runs.findRun(key)) ?? run;
    return {
      value: outcome.value as T,
      receipt: { commandId: command.id, revision: after.revision, state: deriveState(after).state },
    };
  }

  /** The command path for the CLI: the command runs in this process and answers like the pipeline did. */
  async inProcess(
    type: CommandType,
    key: string,
    payload: Record<string, unknown>,
    run: () => Promise<PipelineResult>,
  ): Promise<PipelineResult> {
    try {
      assertKey(key);
    } catch (error) {
      return { exitCode: 1, message: error instanceof Error ? error.message : 'key is invalid' };
    }
    try {
      const { value } = await this.submit<PipelineResult>(type, key, payload, { create: { targetPath: null }, run });
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

  /** At boot: an executing command is lost, an accepted one runs. A Stop is kept: its run is halted, and it runs again. */
  async recover(): Promise<void> {
    for (const key of await this.commands.stoppingKeys()) this.runStop.halt(key);
    await this.commands.failExecuting('server restarted');
    for (const command of await this.commands.listAccepted()) {
      const key = await this.commands.keyOf(command);
      if (key) this.schedule(command, key);
    }
  }

  /** `code` is the block reason an HTTP Resume is checked against. The CLI passes null: its run never refused a block. */
  private admit(type: CommandType, key: string, run: RunEntity | null, code: string | null): void {
    if (!run) return;
    const held = this.runs.held(run);
    if (BUSY_TYPES.includes(type) && held) {
      throw conflict('RUN_BUSY', `${key} is already running`, run, 'running');
    }
    const state = deriveState(
      { status: run.status === 'running' && !held ? 'failed' : run.status, stateReason: run.stateReason },
      { blockCode: code ?? undefined },
    );
    if (
      type === 'resume' &&
      code !== null &&
      state.state === 'blocked' &&
      !actionsFor(state.state, state.reason?.code ?? null).includes('resume')
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
        this.settle(command.id, { ok: false, error: new ConflictException(`${key} command was superseded`) });
        return;
      }
      const handler = this.inline.get(command.id) ?? this.handlers.get(command.type as CommandType);
      if (!handler) {
        throw new SwarmloopError(`${command.type} has no handler`);
      }
      const payload = JSON.parse(command.payload) as Record<string, unknown>;
      const value = await handler(key, payload, { commandId: command.id, created: payload.created === true });
      await this.commands.finish(command.id, 'succeeded', { value });
      this.settle(command.id, { ok: true, value });
    } catch (error) {
      this.logger.warn(`${command.type} of ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.commands
        .finish(command.id, 'failed', { error: { message: error instanceof Error ? error.message : String(error) } })
        .catch(() => undefined);
      this.settle(command.id, { ok: false, error });
    } finally {
      this.inline.delete(command.id);
      this.scheduled.delete(command.id);
    }
  }

  private settle(id: string, outcome: Outcome): void {
    const waiting = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    waiting.forEach((resolve) => resolve(outcome));
  }

  /** Waits for the executor, or reads what an earlier executor stored. */
  private outcome(command: CommandEntity): Promise<Outcome> {
    return new Promise((resolve) => {
      this.waiters.set(command.id, [...(this.waiters.get(command.id) ?? []), resolve]);
      void this.commands.find(command.id).then((stored) => {
        if (stored?.state === 'succeeded' || stored?.state === 'failed' || stored?.state === 'superseded') {
          this.settle(command.id, stored.state === 'succeeded' ? this.storedValue(stored) : this.storedError(stored));
        }
      });
    });
  }

  private storedValue(stored: CommandEntity): Outcome {
    const result = JSON.parse(stored.result ?? 'null') as { value?: unknown } | null;
    return { ok: true, value: result?.value };
  }

  private storedError(stored: CommandEntity): Outcome {
    const result = JSON.parse(stored.result ?? 'null') as { error?: { message: string } } | null;
    return { ok: false, error: new ConflictException(result?.error?.message ?? `the command is ${stored.state}`) };
  }
}
