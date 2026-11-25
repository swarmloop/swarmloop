import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { StoredAgents } from '../contract/api';
import type { AppConfig } from '../config/env';
import { PersonalTokens } from '../auth/personal-tokens.service';
import { FlowRepository } from '../history/flow.repository';
import { UserSettingRepository } from '../history/user-setting.repository';
import { CommandService } from '../pipeline/command.service';
import type { PipelineService } from '../pipeline/pipeline.service';
import { createTestApp, type TestApp } from '../testing/test-app';
import { CliPersons } from './cli-person';
import { DoctorCommand } from './doctor.command';
import { FetchCommand } from './fetch.command';
import { RunCommand } from './run.command';
import { StepCommand } from './step.command';

const NO_PERSON_MESSAGE =
  'run and step act as a person: create a token in Settings → API tokens and set SWARMLOOP_TOKEN';

const ROLE = [{ runtime: 'claude', model: 'm-claude' }];
const AGENTS = { main: { implement: ROLE }, subtask: { implement: ROLE } } as unknown as StoredAgents;

describe('the CLI acts for a person', () => {
  let app: TestApp;
  let out: jest.SpyInstance;
  let err: jest.SpyInstance;

  beforeEach(async () => {
    out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    app = await createTestApp({ env: { ANTHROPIC_API_KEY: 'sk-ant-server-4d1e8f7a2b9c' } });
  });

  afterEach(async () => {
    out.mockRestore();
    err.mockRestore();
    process.exitCode = undefined;
    await app.close();
  });

  const persons = (token: string) =>
    new CliPersons(
      { env: { SWARMLOOP_TOKEN: token } } as AppConfig,
      app.app.get(PersonalTokens),
      app.app.get(UserSettingRepository),
    );
  const pipeline = { runThrough: async () => ({ exitCode: 0, message: 'ran' }) } as unknown as PipelineService;
  const runCommand = (token: string) =>
    new RunCommand(pipeline, app.app.get(CommandService), app.app.get(FlowRepository), persons(token));
  const stepCommand = (token: string) =>
    new StepCommand(
      { step: async () => ({ exitCode: 0, message: 'stepped' }) } as unknown as PipelineService,
      app.app.get(CommandService),
      persons(token),
    );
  const errors = () => err.mock.calls.map(([text]) => String(text)).join('');
  const rows = () =>
    app.app
      .get(DataSource)
      .query<{ key: string; started_by: string | null; agents: string | null }[]>('SELECT * FROM runs');

  it.each([
    ['no token', ''],
    ['an unknown token', 'sl_unknown-token-value-0123456789abcdef'],
  ])('refuses run and step with %s and writes nothing', async (_name, token) => {
    await runCommand(token).run(['PROJ-1'], { phases: ['research'] } as never);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await stepCommand(token).run(['research', 'PROJ-1'], {});
    expect(process.exitCode).toBe(1);
    expect(errors()).toBe(`${NO_PERSON_MESSAGE}\n${NO_PERSON_MESSAGE}\n`);
    expect(await rows()).toEqual([]);
  });

  it('refuses a revoked and an expired token', async () => {
    await app.personToken('ann');
    const tokens = app.app.get(PersonalTokens);
    const revoked = await tokens.create('ann', 'gone', null);
    const expired = await tokens.create('ann', 'old', 1);
    await tokens.revoke('ann', revoked.id);
    app.clock.advance(2 * 24 * 3600 * 1000);
    for (const value of [revoked.value, expired.value]) {
      expect(await persons(value).resolve()).toEqual({ exitCode: 1, message: NO_PERSON_MESSAGE });
    }
  });

  it('submits run and step as the person of a valid token, with their agent lists', async () => {
    await app.personToken('ann');
    await app.app.get(UserSettingRepository).save('ann', { agents: AGENTS });
    const { value } = await app.app.get(PersonalTokens).create('ann', 'cli', null);

    await runCommand(value).run(['PROJ-1'], {});
    await stepCommand(value).run(['research', 'PROJ-2'], {});

    expect(errors()).toBe('');
    const stored = await rows();
    expect(stored.map(({ key, started_by }) => [key, started_by])).toEqual([
      ['PROJ-1', 'ann'],
      ['PROJ-2', 'ann'],
    ]);
    expect(JSON.parse(stored[0]?.agents ?? 'null')).toEqual(AGENTS);
  });

  it('keeps fetch and doctor working without a token', async () => {
    await new FetchCommand({
      fetch: async () => ({ exitCode: 0, message: 'fetched' }),
    } as unknown as PipelineService).run(['PROJ-1']);
    expect(out).toHaveBeenCalledWith('fetched\n');
    await new DoctorCommand({ fresh: async () => ({ items: [], checkedAt: null }) } as never).run();
    expect(process.exitCode).toBe(0);
    expect(errors()).toBe('');
  });
});
