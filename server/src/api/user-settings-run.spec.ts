import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { agentFor } from '../config/agents';
import type { SettingsBody } from '../contract/api';
import { RunRepository } from '../history/run.repository';
import { UserSettingRepository } from '../history/user-setting.repository';
import type { CommandService, SubmitOptions } from '../pipeline/command.service';
import { boot } from '../testing/runs.spec-helpers';
import { RunCommandsService } from './run-commands.service';
import { RunQueriesService } from './run-queries.service';
import { RunsController } from './runs.controller';
import type { ShellService } from './shell.service';

const MINE: SettingsBody = {
  agents: {
    main: { plan: [{ runtime: 'claude', model: 'mine-plan' }] },
    subtask: { implement: [{ runtime: 'codex', model: 'mine-sub' }] },
  },
};
const THEIRS: SettingsBody = { agents: { main: { plan: [{ runtime: 'codex', model: 'theirs-plan' }] } } };

async function world() {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-user-settings-'));
  const app = await boot(root);
  const runs = app.get(RunRepository);
  const settings = app.get(UserSettingRepository);
  // The command door makes the waiting row from `create`, as `CommandRepository.accept` does.
  const commands = {
    submit: jest.fn(
      async (_type: string, key: string, _payload: object, options: { create?: SubmitOptions['create'] }) => {
        const create = options.create;
        await runs.saveRun(runs.newWaitingRun(key, null, create?.startedBy, create?.agents));
        return { value: { key, status: 'started' }, receipt: { commandId: 'c', revision: 1, state: 'idle' } };
      },
    ),
  };
  const controller = new RunsController(
    app.get(RunQueriesService),
    app.get(RunCommandsService),
    commands as unknown as CommandService,
    {} as ShellService,
    settings,
  );
  const start = (key: string, actor: string | null, body: object = {}) =>
    controller.create({ key, prompt: 'Ship it', projects: ['demo'], ...body }, { status: jest.fn() }, actor);
  return { app, runs, settings, start, env: app.get(AppConfig).env };
}

describe('a run uses the starter settings', () => {
  it('uses a person plan list and stores it on their run', async () => {
    const { app, runs, settings, start, env } = await world();
    try {
      await settings.save('alice', MINE);
      await start('proj-1', 'alice');
      const run = await runs.findRun('proj-1');
      expect(run?.agents).toEqual(MINE.agents);
      expect(agentFor(env, run, 'plan')).toEqual({ runtime: 'claude', model: 'mine-plan' });
    } finally {
      await app.close();
    }
  });

  it('leaves the run agents when the settings change mid-run', async () => {
    const { app, runs, settings, start, env } = await world();
    try {
      await settings.save('alice', MINE);
      await start('proj-2', 'alice');
      await settings.save('alice', THEIRS);
      const run = await runs.findRun('proj-2');
      expect(agentFor(env, run, 'plan')).toEqual({ runtime: 'claude', model: 'mine-plan' });
    } finally {
      await app.close();
    }
  });

  it('gives another person their own settings', async () => {
    const { app, runs, settings, start, env } = await world();
    try {
      await settings.save('alice', MINE);
      await settings.save('bob', THEIRS);
      await start('proj-3', 'alice');
      await start('proj-4', 'bob');
      expect(agentFor(env, await runs.findRun('proj-4'), 'plan')).toEqual({ runtime: 'codex', model: 'theirs-plan' });
      expect(agentFor(env, await runs.findRun('proj-3'), 'plan').model).toBe('mine-plan');
    } finally {
      await app.close();
    }
  });

  it('uses env and stores nothing without settings or for the machine token', async () => {
    const { app, runs, settings, start, env } = await world();
    try {
      await settings.save('alice', MINE);
      await start('proj-5', 'carol');
      await start('proj-6', null);
      for (const key of ['proj-5', 'proj-6']) {
        const run = await runs.findRun(key);
        expect(run?.agents).toBeNull();
        expect(agentFor(env, run, 'plan')).toEqual(agentFor(env, null, 'plan'));
      }
    } finally {
      await app.close();
    }
  });

  it('lets a subtask copy its parent choice and use its subtask tier', async () => {
    const { app, runs, settings, start, env } = await world();
    try {
      await settings.save('alice', MINE);
      await start('proj-7', 'alice');
      const parent = await runs.findRun('proj-7');
      const child = await runs.openSubtask('proj-7-a', parent?.id ?? 0, 'a', 'alice', parent?.agents);
      expect(child.agents).toEqual(MINE.agents);
      expect(child.runtime).toBe('codex');
      expect(agentFor(env, child, 'implement')).toEqual({ runtime: 'codex', model: 'mine-sub' });
      expect(agentFor(env, parent, 'implement').runtime).not.toBe('codex');
    } finally {
      await app.close();
    }
  });

  it.each([
    ['auto', undefined, true],
    ['off', undefined, false],
    ['auto', false, false],
    ['off', true, true],
  ] as const)(
    'the server SPLIT=%s decides a run sent with split %s: it plans split %s',
    async (split, sent, planned) => {
      const { app, env } = await world();
      try {
        (env as { SPLIT: string }).SPLIT = split;
        const body = { key: 'p-8', prompt: 'x', projects: ['demo'], ...(sent === undefined ? {} : { split: sent }) };
        expect((await app.get(RunCommandsService).plan(body)).split).toBe(planned);
      } finally {
        await app.close();
      }
    },
  );
});
