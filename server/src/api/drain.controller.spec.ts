import type { CommandService } from '../pipeline/command.service';
import { DrainService } from '../pipeline/drain.service';
import type { RunRepository } from '../history/run.repository';
import type { RunEntity } from '../history/entities';
import { DrainController } from './drain.controller';

function controller(held: string[], pending = 0) {
  const runs = {
    listRuns: async () => ['a', 'b', 'c'].map((key) => ({ key }) as RunEntity),
    held: (run: RunEntity) => held.includes(run.key),
  } as unknown as RunRepository;
  const commands = { pending: () => pending } as CommandService;
  return new DrainController(new DrainService(), commands, runs);
}

describe('DrainController', () => {
  it('is not draining, and so not idle, before the drain starts', async () => {
    expect(await controller([]).status()).toEqual({ draining: false, idle: false, running: 0 });
  });

  it('counts the runs that hold a step and is idle when they are gone', async () => {
    const drain = controller(['a', 'c']);

    expect(await drain.start()).toEqual({ draining: true, idle: false, running: 2 });
  });

  it('is not idle while a command is queued', async () => {
    expect(await controller([], 1).start()).toEqual({ draining: true, idle: false, running: 0 });
  });

  it('is idle once nothing runs and nothing is queued', async () => {
    expect(await controller([]).start()).toEqual({ draining: true, idle: true, running: 0 });
  });
});
