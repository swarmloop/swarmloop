import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import type { CommandView } from '../contract/command';
import type { CommandService } from '../pipeline/command.service';
import { CommandsController } from './commands.controller';

const view: CommandView = {
  commandId: 'one',
  type: 'create-repository',
  state: 'succeeded',
  value: null,
  error: null,
};

function controller(owner: string | null): CommandsController {
  const commands = {
    view: async (id: string, actor: string | null) => (id === 'one' && actor === owner ? view : null),
  } as unknown as CommandService;
  return new CommandsController(commands);
}

describe('CommandsController', () => {
  it('answers the view to the command actor', async () => {
    await expect(controller('alice').view('alice', 'one')).resolves.toEqual(view);
  });

  it('answers the view when sign-in is off', async () => {
    await expect(controller(null).view(null, 'one')).resolves.toEqual(view);
  });

  it('answers 404 to another person and for a missing command', async () => {
    await expect(controller('alice').view('bob', 'one')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller('alice').view('alice', 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
