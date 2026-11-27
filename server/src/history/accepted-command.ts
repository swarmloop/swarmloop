import { randomUUID } from 'crypto';
import type { EntityManager } from 'typeorm';
import type { CommandType } from '../contract/command';
import { CommandEntity } from './entities';

interface AcceptedCommandInput {
  /** The run the command is asked of; null for a command of no run, which has a scope. */
  runId: number | null;
  scope?: string | null;
  type: CommandType;
  /** The payload as it is stored: a JSON string. */
  payload: string;
  idempotencyKey: string | null;
  expectedRevision?: number;
  actor?: string | null;
  now: string;
}

/** The command stored under this run (or scope) and key, or a new `accepted` row. Runs inside the caller's transaction. */
export async function insertAcceptedCommand(
  manager: EntityManager,
  { runId, scope, type, payload, idempotencyKey, expectedRevision, actor, now }: AcceptedCommandInput,
): Promise<CommandEntity> {
  const commands = manager.getRepository(CommandEntity);
  const stored = idempotencyKey
    ? await commands.findOneBy(
        runId === null ? { scope: scope ?? undefined, idempotencyKey } : { runId, idempotencyKey },
      )
    : null;
  if (stored) return stored;
  return commands.save(
    commands.create({
      id: randomUUID(),
      runId,
      scope: scope ?? null,
      type,
      payload,
      idempotencyKey,
      expectedRevision: expectedRevision ?? null,
      actor: actor ?? null,
      state: 'accepted',
      result: null,
      createdAt: now,
      updatedAt: now,
    }),
  );
}
