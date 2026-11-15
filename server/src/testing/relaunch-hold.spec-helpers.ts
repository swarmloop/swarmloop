import { CommandService, type CommandHandler } from '../pipeline/command.service';

/**
 * The relaunch of a cut step is stored with its visit, and `handler` is all that runs of it: every CommandService,
 * also the one of a restarted app, gets it for `resume`. Undo it with `jest.restoreAllMocks()`.
 */
export function holdRelaunches(handler: CommandHandler): void {
  const register = Reflect.get<CommandService, 'register'>(CommandService.prototype, 'register');
  jest.spyOn(CommandService.prototype, 'register').mockImplementation(function (this: CommandService, type, original) {
    register.call(this, type, type === 'resume' ? handler : original);
  });
}
