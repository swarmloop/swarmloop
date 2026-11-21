import { randomUUID } from 'crypto';
import type { EntityManager } from 'typeorm';
import type { CommandType } from '../contract/command';
import { CommandEntity } from './entities';

interface AcceptedCommandInput {
  runId: number;
  type: CommandType;
  /** The payload as it is stored: a JSON string. */
  payload: string;
  idempotencyKey: string | null;
  expectedRevision?: number;
  actor?: string | null;
  now: string;
}

/** The command stored under this run and key, or a new `accepted` row. Runs inside the caller's transaction. */
export async function insertAcceptedCommand(
  manager: EntityManager,
  { runId, type, payload, idempotencyKey, expectedRevision, actor, now }: AcceptedCommandInput,
): Promise<CommandEntity> {
  const commands = manager.getRepository(CommandEntity);
  const stored = idempotencyKey ? await commands.findOneBy({ runId, idempotencyKey }) : null;
  if (stored) return stored;
  return commands.save(
    commands.create({
      id: randomUUID(),
      runId,
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
