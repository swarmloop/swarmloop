import 'reflect-metadata';
import { ChatService } from './chat.service';
import { RunCommandsService } from './run-commands.service';
import { RunQueriesService } from './run-queries.service';
import { RunRebaseService } from './run-rebase.service';
import { httpStatus, RunsController } from './runs.controller';
import { ShellService } from './shell.service';

function controllerWith(commands: object = {}, rebases: object = {}): RunsController {
  return new RunsController(
    {} as RunQueriesService,
    commands as RunCommandsService,
    rebases as RunRebaseService,
    {} as ChatService,
    {} as ShellService,
  );
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
  it('sets 202 when a created run starts', async () => {
    const commands = { start: jest.fn().mockResolvedValue({ key: 'proj-1', status: 'started' }) };
    const response = { status: jest.fn() };
    const result = await controllerWith(commands).create({ key: 'proj-1', prompt: 'Ship it' }, response);
    expect(result).toEqual({ key: 'proj-1', status: 'started' });
    expect(response.status).toHaveBeenCalledWith(202);
  });

  it('sets 200 when a run is stopped', async () => {
    const commands = { stop: jest.fn().mockResolvedValue({ key: 'proj-9', status: 'stopped' }) };
    const response = { status: jest.fn() };
    const result = await controllerWith(commands).stop('proj-9', response);
    expect(result).toEqual({ key: 'proj-9', status: 'stopped' });
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it('sets 200 when a rebase finds the run done', async () => {
    const rebases = { rebase: jest.fn().mockResolvedValue({ key: 'proj-2', status: 'done' }) };
    const response = { status: jest.fn() };
    const result = await controllerWith({}, rebases).rebase('proj-2', response);
    expect(result).toEqual({ key: 'proj-2', status: 'done' });
    expect(response.status).toHaveBeenCalledWith(200);
  });
});
