import 'reflect-metadata';
import type { CommandService } from '../pipeline/command.service';
import { BacklogStartPort } from '../pipeline/backlog/backlog-start-port';
import type { UserSettingRepository } from '../history/user-setting.repository';
import { BacklogStart } from './backlog-start';
import type { RunCommandsService } from './run-commands.service';
import type { RunQueriesService } from './run-queries.service';
import { RunsController } from './runs.controller';

const agents = { main: { implement: [{ runtime: 'claude', model: 'm' }] } };

function doubles() {
  const plan = { key: 'task-1', prompt: 'Ship it', phases: [], phasesGiven: false, projects: ['web', 'server'] };
  const runs = { plan: jest.fn().mockResolvedValue(plan) };
  const commands = {
    submit: jest.fn().mockResolvedValue({ value: { key: 'task-1', status: 'started' }, receipt: { commandId: 'c-1' } }),
  };
  const settings = { read: jest.fn().mockResolvedValue({ agents }) };
  return { runs, commands, settings };
}

describe('BacklogStart', () => {
  it('starts a task with the command and the create options that POST /runs dispatches', async () => {
    const posted = doubles();
    const controller = new RunsController(
      {} as RunQueriesService,
      posted.runs as unknown as RunCommandsService,
      posted.commands as unknown as CommandService,
      posted.settings as unknown as UserSettingRepository,
    );
    await controller.create(
      { key: 'task-1', prompt: 'Ship it', projects: ['web', 'server'] },
      { status: jest.fn() },
      'ada',
    );

    const scheduled = doubles();
    const port = new BacklogStartPort();
    new BacklogStart(
      port,
      scheduled.runs as unknown as RunCommandsService,
      scheduled.commands as unknown as CommandService,
      scheduled.settings as unknown as UserSettingRepository,
    ).onModuleInit();
    await port.start({ key: 'task-1', prompt: 'Ship it', projects: ['web', 'server'], owner: 'ada' });

    expect(scheduled.runs.plan).toHaveBeenCalledWith(
      { key: 'task-1', prompt: 'Ship it', projects: ['web', 'server'] },
      'ada',
    );
    const [type, key, payload, options] = scheduled.commands.submit.mock.calls[0] as unknown[];
    const [postedType, postedKey, postedPayload, postedOptions] = posted.commands.submit.mock.calls[0] as unknown[];
    expect([type, key, payload]).toEqual([postedType, postedKey, postedPayload]);
    expect(options).toEqual({ create: (postedOptions as { create: unknown }).create });
    expect((options as { create: unknown }).create).toEqual({ targetPath: null, startedBy: 'ada', agents });
  });

  it('starts with no stored agents when the owner has no settings', async () => {
    const test = doubles();
    test.settings.read.mockResolvedValue(null);
    const port = new BacklogStartPort();
    new BacklogStart(
      port,
      test.runs as unknown as RunCommandsService,
      test.commands as unknown as CommandService,
      test.settings as unknown as UserSettingRepository,
    ).onModuleInit();
    await port.start({ key: 'task-1', prompt: 'Ship it', projects: ['web'], owner: 'ada' });
    expect(test.commands.submit.mock.calls[0]?.[3]).toEqual({
      create: { targetPath: null, startedBy: 'ada', agents: null },
    });
  });
});

describe('BacklogStart key', () => {
  it('returns the key of the session the server opened', async () => {
    const test = doubles();
    test.runs.plan.mockResolvedValue({
      key: 'task-1--2',
      prompt: 'Ship it',
      phases: [],
      phasesGiven: false,
      projects: ['web'],
    });
    const port = new BacklogStartPort();
    new BacklogStart(
      port,
      test.runs as unknown as RunCommandsService,
      test.commands as unknown as CommandService,
      test.settings as unknown as UserSettingRepository,
    ).onModuleInit();
    await expect(port.start({ key: 'task-1', prompt: 'Ship it', projects: ['web'], owner: 'ada' })).resolves.toBe(
      'task-1--2',
    );
    expect(test.commands.submit.mock.calls[0]?.[1]).toBe('task-1--2');
  });
});

describe('BacklogStartPort', () => {
  it('refuses a start until the API registers its function', async () => {
    await expect(new BacklogStartPort().start({ key: 'a', prompt: 'p', projects: [], owner: 'ada' })).rejects.toThrow(
      'cannot start',
    );
  });
});
