import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { testEnv } from '../config/env.spec-helpers';
import { AppConfig } from '../config/env';
import type { SettingsBody } from '../contract/api';
import { UserSettingRepository } from '../history/user-setting.repository';
import { boot } from '../testing/runs.spec-helpers';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

const KEYS = { ANTHROPIC_API_KEY: 'sk-secret-anthropic', SWARMLOOP_SECRET: 'top-secret-value' };
const MINE: SettingsBody = {
  agents: {
    main: {
      plan: [
        { runtime: 'claude', model: 'opus' },
        { runtime: 'cursor', model: 'grok' },
      ],
    },
  },
  split: false,
};

async function world() {
  const app = await boot(await mkdtemp(join(tmpdir(), 'swarmloop-settings-')));
  const env = testEnv({
    ...KEYS,
    CURSOR_API_KEY: 'cur',
    AGENTS_PLAN: 'claude:opus,cursor:grok,codex:gpt',
    SPLIT: 'auto',
    MODEL_PLAN: 'grok',
    MODEL_IMPLEMENT: 'grok',
  });
  const repo = app.get(UserSettingRepository);
  const controller = new SettingsController(new SettingsService(new AppConfig(env), repo));
  return { app, repo, controller, env };
}

describe('settings', () => {
  it('saves and reads back what a person chose', async () => {
    const { app, repo, controller } = await world();
    try {
      const saved = await controller.save('alice', MINE);
      expect(saved.settings).toEqual(MINE);
      expect((await controller.read('alice')).settings).toEqual(MINE);
      expect(await repo.read('alice')).toEqual(MINE);
      expect((await controller.read('bob')).settings).toEqual({});
    } finally {
      await app.close();
    }
  });

  it('refuses a runtime that is not connected, with the reason, and stores nothing', async () => {
    const { app, repo, controller } = await world();
    try {
      await controller.save('alice', MINE);
      const body = { agents: { main: { plan: [{ runtime: 'codex', model: 'gpt' }] } } };
      await expect(controller.save('alice', body)).rejects.toThrow(/codex:gpt of plan has no credential: .+/);
      expect(await repo.read('alice')).toEqual(MINE);
    } finally {
      await app.close();
    }
  });

  it('refuses an unknown model', async () => {
    const { app, controller } = await world();
    try {
      const body = { agents: { main: { plan: [{ runtime: 'claude', model: 'nope' }] } } };
      await expect(controller.save('alice', body)).rejects.toThrow(/claude:nope.*unknown model/);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['an empty list', { agents: { main: { plan: [] } } }],
    ['an unknown role', { agents: { main: { chat: [{ runtime: 'claude', model: 'opus' }] } } }],
    ['an unknown tier', { agents: { side: {} } }],
    ['a non-boolean split', { split: 'yes' }],
    ['an unknown key', { theme: 'dark' }],
  ])('refuses %s', async (_name, body) => {
    const { app, repo, controller } = await world();
    try {
      await expect(controller.save('alice', body)).rejects.toThrow(BadRequestException);
      expect(await repo.read('alice')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('gives the machine token the defaults and refuses its PUT', async () => {
    const { app, repo, controller } = await world();
    try {
      await repo.save('machine', MINE);
      const view = await controller.read('machine');
      expect(view.settings).toEqual({});
      expect(view.defaults.agents.main.plan).toEqual(['claude:opus', 'cursor:grok', 'codex:gpt']);
      expect(view.defaults.split).toBe(true);
      expect(view.runtimes.map((entry) => entry.runtime)).toEqual(['cursor', 'claude']);
      expect(() => controller.save('machine', MINE)).toThrow(ForbiddenException);
    } finally {
      await app.close();
    }
  });

  it('shows secrets only as set or not set', async () => {
    const { app, controller } = await world();
    try {
      const view = await controller.read('alice');
      const named = Object.fromEntries(view.server.map((entry) => [entry.name, entry.value]));
      expect(named.SWARMLOOP_SECRET).toBe('set');
      expect(named.SWARMLOOP_TOKEN).toBe('not set');
      expect(Object.keys(named)).toEqual(
        expect.arrayContaining(['PROJECT_HOSTS_ALLOW', 'SANDBOX_EGRESS', 'SANDBOX_DOCKER_RUNTIME']),
      );
      expect(named.MAX_RUN_USD).toBe(String(testEnv().MAX_RUN_USD));
      expect(JSON.stringify(view)).not.toMatch(/sk-secret-anthropic|top-secret-value/);
    } finally {
      await app.close();
    }
  });
});
