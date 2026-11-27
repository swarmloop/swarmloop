import 'reflect-metadata';
import { UnprocessableEntityException } from '@nestjs/common';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LiveCommand } from '../contract/live';
import { seededBoot } from '../api/runs-boot.spec-helpers';
import { CommandRepository } from '../history/command.repository';
import { RunRepository } from '../history/run.repository';
import { LiveHub } from '../live/live.hub';
import { save } from '../testing/runs.spec-helpers';
import { CommandService } from './command.service';

const SCOPE = 'repositories:alice';

async function app(name: string) {
  return seededBoot(await mkdtemp(join(tmpdir(), `swarmloop-command-scoped-${name}-`)));
}

describe('CommandService, commands of no run', () => {
  it('stores the command with its scope and no run, runs its handler with the actor and tells the hub', async () => {
    const testApp = await app('ran');
    try {
      const commands = testApp.get(CommandService);
      const ended: LiveCommand[] = [];
      testApp.get(LiveHub).onCommandEnded((entry) => ended.push(entry));
      const calls: unknown[][] = [];
      commands.register('create-repository', async (...call) => {
        calls.push(call);
        return { name: 'shop' };
      });
      const run = await save(testApp.get(RunRepository), 'proj-1', 'implement', 'waiting');

      const command = await commands.acceptScoped('create-repository', SCOPE, { name: 'shop' }, { actor: 'alice' });
      await commands.idle();

      const stored = await testApp.get(CommandRepository).find(command.id);
      expect(stored).toMatchObject({ runId: null, scope: SCOPE, actor: 'alice', state: 'succeeded' });
      expect(calls).toEqual([[SCOPE, { name: 'shop' }, { commandId: command.id, actor: 'alice' }]]);
      expect(ended).toEqual([{ commandId: command.id, state: 'succeeded' }]);
      expect((await testApp.get(RunRepository).findRun('proj-1'))?.revision).toBe(run.revision);
    } finally {
      await testApp.close();
    }
  });

  it('ends a failing command failed with its message and tells the hub', async () => {
    const testApp = await app('failed');
    try {
      const commands = testApp.get(CommandService);
      const ended: LiveCommand[] = [];
      testApp.get(LiveHub).onCommandEnded((entry) => ended.push(entry));
      commands.register('remote-refresh', async () => {
        throw new Error('the host refuses');
      });

      const command = await commands.acceptScoped('remote-refresh', SCOPE, { host: 'gitlab' }, { actor: 'alice' });
      await commands.idle();

      expect(ended).toEqual([{ commandId: command.id, state: 'failed' }]);
      expect(await commands.view(command.id, 'alice')).toMatchObject({
        state: 'failed',
        error: { message: 'the host refuses' },
      });
    } finally {
      await testApp.close();
    }
  });

  it('replays the stored command for the same key and scope, and refuses another payload', async () => {
    const testApp = await app('idem');
    try {
      const commands = testApp.get(CommandService);
      const handler = jest.fn(async () => 'done');
      commands.register('create-repository', handler);
      const options = { idempotencyKey: 'attempt-1', actor: 'alice' };

      const first = await commands.acceptScoped('create-repository', SCOPE, { name: 'shop' }, options);
      const again = await commands.acceptScoped('create-repository', SCOPE, { name: 'shop' }, options);
      await commands.idle();

      expect(again.id).toBe(first.id);
      expect(handler).toHaveBeenCalledTimes(1);
      await expect(
        commands.acceptScoped('create-repository', SCOPE, { name: 'other' }, options),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      const elsewhere = await commands.acceptScoped('create-repository', 'repositories:bob', { name: 'shop' }, options);
      expect(elsewhere.id).not.toBe(first.id);
    } finally {
      await testApp.close();
    }
  });

  it('answers a view to its actor only; with sign-in off both actors are null', async () => {
    const testApp = await app('view');
    try {
      const commands = testApp.get(CommandService);
      commands.register('create-repository', async () => ({ name: 'shop' }));
      const mine = await commands.acceptScoped('create-repository', SCOPE, {}, { actor: 'alice' });
      const open = await commands.acceptScoped('create-repository', 'repositories:', {}, { actor: null });
      await commands.idle();

      expect(await commands.view(mine.id, 'alice')).toEqual({
        commandId: mine.id,
        type: 'create-repository',
        state: 'succeeded',
        value: { name: 'shop' },
        error: null,
      });
      expect(await commands.view(mine.id, 'bob')).toBeNull();
      expect(await commands.view(open.id, null)).toMatchObject({ state: 'succeeded' });
      expect(await commands.view('missing', 'alice')).toBeNull();
    } finally {
      await testApp.close();
    }
  });

  it('runs an accepted command after a restart and fails one a dead process held with server restarted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-command-scoped-lost-'));
    const first = await seededBoot(root);
    let waitingId = '';
    let lostId = '';
    try {
      const repository = first.get(CommandRepository);
      waitingId = (await repository.acceptScoped({ type: 'remote-refresh', scope: SCOPE, payload: {} })).command.id;
      lostId = (await repository.acceptScoped({ type: 'create-repository', scope: SCOPE, payload: { a: 1 } })).command
        .id;
      await repository.start(lostId);
    } finally {
      await first.close();
    }
    const second = await seededBoot(root);
    try {
      const commands = second.get(CommandService);
      const ended: LiveCommand[] = [];
      second.get(LiveHub).onCommandEnded((entry) => ended.push(entry));
      commands.register('remote-refresh', async () => 'ok');
      commands.register('create-repository', jest.fn());

      await commands.recover();
      await commands.idle();

      const repository = second.get(CommandRepository);
      expect((await repository.find(waitingId))?.state).toBe('succeeded');
      const lost = await repository.find(lostId);
      expect(lost?.state).toBe('failed');
      expect(lost?.result).toContain('server restarted');
      expect(ended).toContainEqual({ commandId: lostId, state: 'failed' });
    } finally {
      await second.close();
    }
  });
});
