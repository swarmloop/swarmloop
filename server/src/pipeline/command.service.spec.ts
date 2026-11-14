import 'reflect-metadata';
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Repository } from 'typeorm';
import { CommandRepository } from '../history/command.repository';
import { CommandEntity } from '../history/entities';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { boot, save } from '../testing/runs.spec-helpers';
import { CommandService } from './command.service';
import { RunStop } from '../agent/run-stop';
import { PersonalCredentials } from '../auth/personal-credentials.service';
import { missingCredential } from '../config/agents';
import type { StoredAgents } from '../contract/api';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { fakeConnection } from '../testing/fake-connection';

async function app(name: string) {
  return boot(await mkdtemp(join(tmpdir(), `swarmloop-command-${name}-`)));
}

const started = { key: 'proj-1', status: 'started' };

describe('CommandService', () => {
  it('gives one command for two Resume calls with one idempotency key', async () => {
    const testApp = await app('idem');
    try {
      await save(testApp.get(RunRepository), 'proj-1', 'implement', 'waiting');
      const commands = testApp.get(CommandService);
      const handler = jest.fn().mockResolvedValue(started);
      commands.register('resume', handler);
      const options = { idempotencyKey: 'once' };

      const [first, second] = await Promise.all([
        commands.submit('resume', 'proj-1', { prompt: 'go' }, options),
        commands.submit('resume', 'proj-1', { prompt: 'go' }, options),
      ]);
      const again = await commands.submit('resume', 'proj-1', { prompt: 'go' }, options);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(second.receipt.commandId).toBe(first.receipt.commandId);
      expect(again.receipt.commandId).toBe(first.receipt.commandId);
      expect(again.value).toEqual(started);
      const stored = testApp.get<Repository<CommandEntity>>(getRepositoryToken(CommandEntity));
      expect(await stored.count()).toBe(1);
    } finally {
      await testApp.close();
    }
  });

  it('answers 422 for the same key with another payload', async () => {
    const testApp = await app('payload');
    try {
      await save(testApp.get(RunRepository), 'proj-1', 'implement', 'waiting');
      const commands = testApp.get(CommandService);
      commands.register('resume', jest.fn().mockResolvedValue(started));
      await commands.submit('resume', 'proj-1', { prompt: 'go' }, { idempotencyKey: 'once' });

      const refused = commands.submit('resume', 'proj-1', { prompt: 'another' }, { idempotencyKey: 'once' });

      await expect(refused).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(refused).rejects.toMatchObject({ status: 422 });
    } finally {
      await testApp.close();
    }
  });

  it('lets one of the API and the CLI write the run when both start at once', async () => {
    const testApp = await app('writer');
    try {
      const runs = testApp.get(RunRepository);
      await save(runs, 'proj-1', 'implement', 'waiting');
      const commands = testApp.get(CommandService);
      const claims: string[] = [];
      const take = async (): Promise<{ exitCode: number; message: string }> => {
        const claimed = await runs.claim('proj-1', 'implement');
        claims.push(claimed.activeAttempt ?? '');
        return { exitCode: 0, message: 'proj-1 started' };
      };
      commands.register('resume', async () => {
        await take();
        return started;
      });

      const settled = await Promise.allSettled([
        commands.submit('resume', 'proj-1', {}),
        commands.inProcess('resume', 'proj-1', {}, take),
      ]);

      expect(claims).toHaveLength(1);
      expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const row = await runs.findRun('proj-1');
      expect(row?.activeAttempt).toBe(claims[0]);
      expect(row?.state).toBe('running');
    } finally {
      await testApp.close();
    }
  });

  it('refuses a start while a writer holds the run, with the code and the state', async () => {
    const testApp = await app('busy');
    try {
      const runs = testApp.get(RunRepository);
      await save(runs, 'proj-1', 'implement', 'waiting');
      await runs.claim('proj-1', 'implement');
      const commands = testApp.get(CommandService);
      commands.register('resume', jest.fn());

      const refused = commands.submit('resume', 'proj-1', {});

      await expect(refused).rejects.toBeInstanceOf(ConflictException);
      await expect(refused).rejects.toMatchObject({
        response: { code: 'RUN_BUSY', state: 'running', message: 'proj-1 is already running' },
      });
    } finally {
      await testApp.close();
    }
  });

  it('refuses a command that expects another revision, with the code and the state', async () => {
    const testApp = await app('revision');
    try {
      const run = await save(testApp.get(RunRepository), 'proj-1', 'implement', 'waiting');
      const commands = testApp.get(CommandService);
      commands.register('resume', jest.fn().mockResolvedValue(started));

      const refused = commands.submit('resume', 'proj-1', {}, { expectedRevision: run.revision + 5 });

      await expect(refused).rejects.toMatchObject({
        status: 409,
        response: { code: 'REVISION_CONFLICT', state: 'idle' },
      });
      const accepted = await commands.submit('resume', 'proj-1', {}, { expectedRevision: run.revision });
      expect(accepted.receipt.revision).toBeGreaterThan(run.revision);
    } finally {
      await testApp.close();
    }
  });

  it('refuses Resume on a block whose reason allows only Replay, and accepts it for a repeated check', async () => {
    const testApp = await app('blocked');
    try {
      const runs = testApp.get(RunRepository);
      const commands = testApp.get(CommandService);
      commands.register('resume', jest.fn().mockResolvedValue(started));
      await save(runs, 'proj-1', 'prepare', 'blocked');

      await expect(commands.submit('resume', 'proj-1', {})).rejects.toMatchObject({
        status: 409,
        response: { message: 'run is blocked' },
      });

      const run = await save(runs, 'proj-2', 'implement-improve', 'blocked');
      await testApp
        .get(DocumentRepository)
        .putDocument(run, 'error', 'repo: npm test failed again on unchanged files after a relaunch\n');
      const resumed = await commands.submit('resume', 'proj-2', {});
      expect(resumed.value).toEqual(started);
    } finally {
      await testApp.close();
    }
  });

  it('lets the CLI run a block that Resume cannot continue', async () => {
    const testApp = await app('cli-blocked');
    try {
      await save(testApp.get(RunRepository), 'proj-1', 'prepare', 'blocked');
      const run = jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-1 started' });

      const result = await testApp.get(CommandService).inProcess('resume', 'proj-1', {}, run);

      expect(run).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ exitCode: 0, message: 'proj-1 started' });
    } finally {
      await testApp.close();
    }
  });

  it('runs a command that was accepted before a crash once after a restart on the same database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-command-crash-'));
    const first = await boot(root);
    let acceptedId = '';
    try {
      await save(first.get(RunRepository), 'proj-1', 'implement', 'waiting');
      const accepted = await first
        .get(CommandRepository)
        .accept({ type: 'resume', key: 'proj-1', payload: { prompt: 'go' }, admit: () => undefined });
      acceptedId = accepted.command.id;
    } finally {
      await first.close();
    }
    const second = await boot(root);
    try {
      const commands = second.get(CommandService);
      const handler = jest.fn().mockResolvedValue(started);
      commands.register('resume', handler);

      await commands.recover();
      await commands.idle();
      await commands.recover();
      await commands.idle();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('proj-1', { prompt: 'go' }, { commandId: acceptedId, created: false });
      expect((await second.get(CommandRepository).find(acceptedId))?.state).toBe('succeeded');
    } finally {
      await second.close();
    }
  });

  it('marks a command that was executing at a crash failed with server restarted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-command-lost-'));
    const first = await boot(root);
    let lostId = '';
    try {
      await save(first.get(RunRepository), 'proj-1', 'implement', 'waiting');
      const repository = first.get(CommandRepository);
      const accepted = await repository.accept({ type: 'resume', key: 'proj-1', payload: {}, admit: () => undefined });
      lostId = accepted.command.id;
      await repository.start(lostId);
    } finally {
      await first.close();
    }
    const second = await boot(root);
    try {
      const commands = second.get(CommandService);
      const handler = jest.fn();
      commands.register('resume', handler);

      await commands.recover();
      await commands.idle();

      const stored = await second.get(CommandRepository).find(lostId);
      expect(stored?.state).toBe('failed');
      expect(stored?.result).toContain('server restarted');
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await second.close();
    }
  });

  it('keeps a Stop that was executing at a crash: the run is halted and the Stop runs again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-command-stop-'));
    const first = await boot(root);
    let stopId = '';
    try {
      await save(first.get(RunRepository), 'proj-1', 'implement', 'running');
      const repository = first.get(CommandRepository);
      stopId = (await repository.accept({ type: 'stop', key: 'proj-1', payload: {}, admit: () => undefined })).command
        .id;
      await repository.start(stopId);
    } finally {
      await first.close();
    }
    const second = await boot(root);
    try {
      const commands = second.get(CommandService);
      const handler = jest.fn().mockResolvedValue({ key: 'proj-1', status: 'stopped' });
      commands.register('stop', handler);

      await commands.recover();
      expect(second.get(RunStop).halted('proj-1')).toBe(true);
      await commands.idle();

      expect(handler).toHaveBeenCalledTimes(1);
      expect((await second.get(CommandRepository).find(stopId))?.state).toBe('succeeded');
    } finally {
      await second.close();
    }
  });

  it('creates the run of a start command in the same transaction and says so to the handler', async () => {
    const testApp = await app('create');
    try {
      const commands = testApp.get(CommandService);
      const handler = jest.fn().mockResolvedValue(started);
      commands.register('start', handler);

      const result = await commands.submit('start', 'proj-1', { key: 'proj-1' }, { create: { targetPath: null } });

      expect(handler).toHaveBeenCalledWith('proj-1', { key: 'proj-1', created: true }, expect.any(Object));
      expect((await testApp.get(RunRepository).findRun('proj-1'))?.revision).toBe(result.receipt.revision);
      expect(result.receipt.revision).toBe(1);
    } finally {
      await testApp.close();
    }
  });

  it('supersedes the commands waiting for a run when a Stop is accepted', async () => {
    const testApp = await app('stop');
    try {
      await save(testApp.get(RunRepository), 'proj-1', 'implement', 'waiting');
      const repository = testApp.get(CommandRepository);
      const waiting = await repository.accept({ type: 'resume', key: 'proj-1', payload: {}, admit: () => undefined });

      await repository.accept({ type: 'stop', key: 'proj-1', payload: {}, admit: () => undefined });

      expect((await repository.find(waiting.command.id))?.state).toBe('superseded');
    } finally {
      await testApp.close();
    }
  });

  describe('a new run and the credentials of its agents', () => {
    const claudeAgents = { main: { plan: [{ runtime: 'claude', model: 'opus' }] } };
    const claude = fakeConnection({ id: 'claude', fields: ['ANTHROPIC_API_KEY'], envName: 'ANTHROPIC_API_KEY' });

    async function start(
      testApp: Awaited<ReturnType<typeof app>>,
      create: { targetPath: null; startedBy?: string | null; agents?: StoredAgents },
      key = 'proj-1',
    ) {
      const commands = testApp.get(CommandService);
      commands.register('start', jest.fn().mockResolvedValue(started));
      return commands.submit('start', key, { key }, { create });
    }

    it('accepts a starter with their own Claude connection', async () => {
      const testApp = await app('own');
      try {
        await testApp.get(PersonalCredentials).store(claude, 'ann', { ANTHROPIC_API_KEY: 'sk-ant-ann-1234' }, null);
        await start(testApp, { targetPath: null, startedBy: 'ann', agents: claudeAgents });
        expect(await testApp.get(RunRepository).findRun('proj-1')).not.toBeNull();
      } finally {
        await testApp.close();
      }
    });

    it('accepts agents that name a level before the model list of their runtime is loaded', async () => {
      const testApp = await app('level');
      try {
        const cursor = fakeConnection({ id: 'cursor', fields: ['CURSOR_API_KEY'] });
        await testApp.get(PersonalCredentials).store(cursor, 'ann', { CURSOR_API_KEY: 'crsr-ann-1234' }, null);
        const levels = { main: { plan: [{ runtime: 'cursor', model: 'grok-4.7', effort: 'high' }] } };
        expect(runtimeFor('cursor').listLoaded()).toBe(false);
        await start(testApp, { targetPath: null, startedBy: 'ann', agents: levels });
        expect(await testApp.get(RunRepository).findRun('proj-1')).not.toBeNull();
      } finally {
        await testApp.close();
      }
    });

    it('refuses a starter without one, names the runtime with the link and stores no run', async () => {
      const testApp = await app('none');
      try {
        const refused = start(testApp, { targetPath: null, startedBy: 'bob', agents: claudeAgents });
        await expect(refused).rejects.toMatchObject({ status: 422 });
        await expect(refused).rejects.toThrow(missingCredential('claude'));
        expect(await testApp.get(RunRepository).findRun('proj-1')).toBeNull();
        expect(await testApp.get<Repository<CommandEntity>>(getRepositoryToken(CommandEntity)).count()).toBe(0);
      } finally {
        await testApp.close();
      }
    });

    it('accepts a start with env keys only', async () => {
      const testApp = await app('env');
      try {
        await start(testApp, { targetPath: null, startedBy: 'bob' });
        expect(await testApp.get(RunRepository).findRun('proj-1')).not.toBeNull();
      } finally {
        await testApp.close();
      }
    });

    it('does not refuse a replay of a run that already exists', async () => {
      const testApp = await app('replay');
      try {
        await save(testApp.get(RunRepository), 'proj-1', 'implement', 'waiting');
        await start(testApp, { targetPath: null, startedBy: 'bob', agents: claudeAgents });
        expect(await testApp.get<Repository<CommandEntity>>(getRepositoryToken(CommandEntity)).count()).toBe(1);
      } finally {
        await testApp.close();
      }
    });
  });
});
