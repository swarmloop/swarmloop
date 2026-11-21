import { BadRequestException } from '@nestjs/common';
import type { CommandReceipt, CommandType } from '../contract/command';
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
