import 'reflect-metadata';
import type { CommandService } from '../pipeline/command.service';
import type { RunCommandsService } from './run-commands.service';
import type { RunQueriesService } from './run-queries.service';
import { httpStatus, RunsController } from './runs.controller';
import type { ShellService } from './shell.service';

function controllerWith(runs: object = {}, commands: object = {}): RunsController {
  return new RunsController(
    {} as RunQueriesService,
    runs as RunCommandsService,
    commands as CommandService,
    {} as ShellService,
  );
}

/** A command service whose handler answered with `value` for the run at revision 4. */
function answering(value: object): { submit: jest.Mock } {
  return {
    submit: jest.fn().mockResolvedValue({ value, receipt: { commandId: 'c-1', revision: 4, state: 'idle' } }),
  };
}

describe('httpStatus', () => {
  it('answers a started run with 202', () => {
    expect(httpStatus({ key: 'proj-1', status: 'started' })).toBe(202);
  });

  it('answers a done or stopped run with 200', () => {
    expect(httpStatus({ key: 'proj-1', status: 'done' })).toBe(200);
    expect(httpStatus({ key: 'proj-1', status: 'stopped' })).toBe(200);
  });
});

describe('RunsController', () => {
  it('passes the paging of the events to the queries', async () => {
    const page = { events: [], next: null };
    const queries = { stepEventPage: jest.fn().mockResolvedValue(page) };
    const controller = new RunsController(
      queries as unknown as RunQueriesService,
      {} as RunCommandsService,
      {} as CommandService,
      {} as ShellService,
    );
    expect(await controller.events('proj-1', 'commit', '4', '50')).toBe(page);
    expect(queries.stepEventPage).toHaveBeenCalledWith('proj-1', { step: 'commit', after: '4', limit: '50' });
  });

  it('sets 202 when a created run starts', async () => {
    const runs = { plan: jest.fn().mockResolvedValue({ key: 'proj-1', phases: [], phasesGiven: false, projects: [] }) };
    const commands = answering({ key: 'proj-1', status: 'started' });
    const response = { status: jest.fn() };
    const result = await controllerWith(runs, commands).create({ key: 'proj-1', prompt: 'Ship it' }, response);
    expect(result).toEqual({ key: 'proj-1', status: 'started', commandId: 'c-1', revision: 4, state: 'idle' });
    expect(commands.submit).toHaveBeenCalledWith('start', 'proj-1', expect.any(Object), {
      idempotencyKey: undefined,
      expectedRevision: undefined,
      create: { targetPath: null },
    });
    expect(response.status).toHaveBeenCalledWith(202);
  });

  it('sets 200 when a run is stopped', async () => {
    const commands = answering({ key: 'proj-9', status: 'stopped' });
    const response = { status: jest.fn() };
    const result = await controllerWith({}, commands).stop('proj-9', response);
    expect(result).toEqual({ key: 'proj-9', status: 'stopped', commandId: 'c-1', revision: 4, state: 'idle' });
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it('sets 200 when a rebase finds the run done', async () => {
    const commands = answering({ key: 'proj-2', status: 'done' });
    const response = { status: jest.fn() };
    const result = await controllerWith({}, commands).rebase('proj-2', response);
    expect(result).toEqual({ key: 'proj-2', status: 'done', commandId: 'c-1', revision: 4, state: 'idle' });
    expect(response.status).toHaveBeenCalledWith(200);
  });
});
