import 'reflect-metadata';
import type { CommandEntity } from '../history/entities';
import type { CommandService } from '../pipeline/command.service';
import { acceptCommand } from './run-command-dispatch';

describe('acceptCommand', () => {
  it('answers the command id while the handler has not finished', async () => {
    const asked: unknown[][] = [];
    const never = new Promise<never>(() => undefined);
    const commands = {
      acceptScoped: async (...call: unknown[]) => {
        asked.push(call);
        return { id: 'one' } as CommandEntity;
      },
      submit: () => never,
    } as unknown as CommandService;

    const accepted = await acceptCommand(
      commands,
      'create-repository',
      'repositories:alice',
      { a: 1 },
      ' try-1 ',
      'alice',
    );

    expect(accepted).toEqual({ commandId: 'one' });
    expect(asked).toEqual([
      ['create-repository', 'repositories:alice', { a: 1 }, { idempotencyKey: 'try-1', actor: 'alice' }],
    ]);
  });
});
