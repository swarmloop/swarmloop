import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, In, Repository } from 'typeorm';
import { Clock } from '../core/clock';
import type { CommandState, CommandType } from '../contract/command';
import type { RunState } from '../contract/run-state';
import { CommandEntity, RunEntity } from './entities';
import { RunRepository } from './run.repository';
import { transaction } from './transaction';
import { deriveState } from './run-state';

interface AcceptInput {
  type: CommandType;
  key: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  expectedRevision?: number;
  /** Creates the run in the same transaction when it does not exist. */
  create?: { targetPath: string | null };
  /** The pure policy. It throws to refuse the command. */
  admit: (run: RunEntity | null) => void;
}

interface Accepted {
  command: CommandEntity;
  run: RunEntity;
  /** The same key and payload came before: this is the stored command. */
  replayed: boolean;
}

/** The commands of the runs: the durable record of what a person asked for. */
@Injectable()
export class CommandRepository {
  constructor(
    private readonly clock: Clock,
    private readonly runs: RunRepository,
    @InjectRepository(CommandEntity) private readonly commands: Repository<CommandEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** One short transaction: the idempotency lookup, the policy, the command row and `runs.revision + 1`. */
  async accept(input: AcceptInput): Promise<Accepted> {
    const accepted = await transaction(this.dataSource, async (manager) => {
      const runTable = manager.getRepository(RunEntity);
      const commandTable = manager.getRepository(CommandEntity);
      let run = await runTable.findOneBy({ key: input.key });
      if (!run && !input.create) {
        throw new NotFoundException(`${input.key} is missing`);
      }
      const stored =
        run && input.idempotencyKey
          ? await commandTable.findOneBy({ runId: run.id, idempotencyKey: input.idempotencyKey })
          : null;
      if (stored) {
        if (stored.type !== input.type || !samePayload(stored.payload, input.payload)) {
          throw new UnprocessableEntityException('the idempotency key was used with another request');
        }
        return { command: stored, run: run!, replayed: true };
      }
      input.admit(run);
      if (run && input.expectedRevision !== undefined && run.revision !== input.expectedRevision) {
        throw conflict('REVISION_CONFLICT', `${input.key} changed since revision ${input.expectedRevision}`, run);
      }
      const created = !run;
      if (!run) {
        run = await runTable.save(this.runs.newWaitingRun(input.key, input.create?.targetPath ?? null));
      }
      const now = this.clock.iso();
      if (input.type === 'stop' || input.type === 'remove') {
        await commandTable.update(
          { runId: run.id, state: 'accepted' satisfies CommandState },
          { state: 'superseded' satisfies CommandState, updatedAt: now },
        );
      }
      const command = await commandTable.save(
        commandTable.create({
          id: randomUUID(),
          runId: run.id,
          type: input.type,
          payload: JSON.stringify(created ? { ...input.payload, created } : input.payload),
          idempotencyKey: input.idempotencyKey ?? null,
          expectedRevision: input.expectedRevision ?? null,
          state: 'accepted',
          result: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      await runTable.update({ id: run.id }, { revision: () => 'revision + 1' });
      return { command, run: await runTable.findOneByOrFail({ id: run.id }), replayed: false };
    });
    return accepted;
  }

  find(id: string): Promise<CommandEntity | null> {
    return this.commands.findOneBy({ id });
  }

  /** The commands to run after a start, oldest first. */
  listAccepted(): Promise<CommandEntity[]> {
    return this.commands.find({ where: { state: 'accepted' }, order: { createdAt: 'ASC' } });
  }

  async keyOf(command: CommandEntity): Promise<string | null> {
    const run = await this.dataSource.getRepository(RunEntity).findOneBy({ id: command.runId });
    return run?.key ?? null;
  }

  /** Takes an accepted command. False when another executor took it or it was superseded. */
  async start(id: string): Promise<boolean> {
    const taken = await this.commands.update(
      { id, state: 'accepted' },
      { state: 'executing', updatedAt: this.clock.iso() },
    );
    return (taken.affected ?? 0) > 0;
  }

  async finish(id: string, state: 'succeeded' | 'failed', result: unknown): Promise<void> {
    await this.commands.update({ id }, { state, result: JSON.stringify(result ?? null), updatedAt: this.clock.iso() });
  }

  /** A command that was executing when the server stopped. l15 replaces this with reconciliation. */
  async failExecuting(reason: string): Promise<void> {
    await this.commands.update(
      { state: 'executing' },
      { state: 'failed', result: JSON.stringify({ error: { message: reason } }), updatedAt: this.clock.iso() },
    );
  }

  /** The commands of a run that are accepted or executing. */
  pending(runId: number): Promise<CommandEntity[]> {
    return this.commands.find({ where: { runId, state: In(['accepted', 'executing']) } });
  }
}

/** A 409 that names its cause and the current state. */
export function conflict(
  code: 'RUN_BUSY' | 'REVISION_CONFLICT',
  message: string,
  run: RunEntity,
  state?: RunState,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message,
    error: 'Conflict',
    code,
    state: state ?? deriveState(run).state,
    revision: run.revision,
  });
}

function samePayload(stored: string, incoming: Record<string, unknown>): boolean {
  const { created: _created, ...rest } = JSON.parse(stored) as Record<string, unknown>;
  return canonical(rest) === canonical(incoming);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
