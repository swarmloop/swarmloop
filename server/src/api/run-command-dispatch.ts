import { BadRequestException } from '@nestjs/common';
import type { CommandAccepted, CommandReceipt, CommandType } from '../contract/command';
import type { CommandService, SubmitOptions } from '../pipeline/command.service';

/** Every mutating route goes through here: accept the command, wait for its handler, add the receipt. */
export async function dispatchCommand<T extends object>(
  commands: CommandService,
  type: CommandType,
  key: string,
  payload: Record<string, unknown> | object,
  idempotencyKey: string | undefined,
  options: Pick<SubmitOptions, 'create' | 'actor'> & { expectedRevision?: unknown } = {},
): Promise<T & CommandReceipt> {
  const { expectedRevision, create, actor } = options;
  if (expectedRevision !== undefined && !Number.isInteger(expectedRevision)) {
    throw new BadRequestException('expectedRevision is not a count');
  }
  const { value, receipt } = await commands.submit<T>(type, key, payload as Record<string, unknown>, {
    idempotencyKey: idempotencyKey?.trim() || undefined,
    expectedRevision: expectedRevision as number | undefined,
    create,
    actor,
  });
  return { ...value, ...receipt };
}

/** Stores a command of no run and answers with its id at once. Its end reaches the caller as the `command` event. */
export async function acceptCommand(
  commands: CommandService,
  type: CommandType,
  scope: string,
  payload: Record<string, unknown>,
  idempotencyKey: string | undefined,
  actor: string | null,
): Promise<CommandAccepted> {
  const command = await commands.acceptScoped(type, scope, payload, {
    idempotencyKey: idempotencyKey?.trim() || undefined,
    actor,
  });
  return { commandId: command.id };
}
