import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopConfigModule } from '../config/config.module';
import { testEnv } from '../config/env.spec-helpers';
import { AppConfig, type SwarmloopEnv } from '../config/env';
import { SettingSources } from '../config/setting-sources';
import { SystemClock } from '../core/clock';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import type { SettingsBody } from '../contract/api';
import { PersonalCredentials } from '../auth/personal-credentials.service';
import { SecretBox } from '../auth/secret-box';
import { IntegrationSecretRepository } from '../history/integration-secret.repository';
import { UserSettingRepository } from '../history/user-setting.repository';
import { fakeConnection } from '../testing/fake-connection';
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
};

/** A fresh price cache of one runtime, as `loadPriceTable` writes it. */
async function cachePrices(root: string, runtime: string, models: string[]): Promise<void> {
  const row = { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1 };
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(
    join(root, 'data', `price-cache-${runtime}.json`),
    JSON.stringify({ fetchedAt: new Date().toISOString(), prices: Object.fromEntries(models.map((m) => [m, row])) }),
  );
}

async function world(extra: Partial<SwarmloopEnv> = {}, sources = new SettingSources({})) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-settings-'));
  const app = await boot(root);
  const env = testEnv({
    SWARMLOOP_ROOT: root,
    ...KEYS,
    CURSOR_API_KEY: 'cur',
    AGENTS_PLAN: 'claude:opus,cursor:grok,codex:gpt',
    SPLIT: 'auto',
    AGENTS_IMPLEMENT: 'cursor:grok',
    AGENTS_REVIEW: 'cursor:grok',
    ...extra,
  });
  const repo = app.get(UserSettingRepository);
  const config = new AppConfig(env);
  const clock = new SystemClock();
  const credentials = new PersonalCredentials(app.get(IntegrationSecretRepository), new SecretBox('k'), clock, config);
  const controller = new SettingsController(new SettingsService(config, repo, clock, credentials, sources));
  return { app, repo, controller, env, root, credentials };
}

describe('settings', () => {
  beforeEach(() => {
    // No price table is reachable unless a test writes a cache.
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
  });
  afterEach(() => jest.restoreAllMocks());

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

  it('lists and accepts a runtime only the person connected, and refuses it for another person', async () => {
    const { app, repo, controller, credentials } = await world();
    try {
      const codex = fakeConnection({ id: 'codex', fields: ['CODEX_API_KEY'] });
      await credentials.store(codex, 'alice', { CODEX_API_KEY: 'sk-codex-alice-1234' }, null);
      const body = { agents: { main: { plan: [{ runtime: 'codex', model: 'gpt' }] } } };
      expect((await controller.read('alice')).runtimes.map((entry) => entry.runtime)).toContain('codex');
      expect((await controller.read('bob')).runtimes.map((entry) => entry.runtime)).not.toContain('codex');
      expect((await controller.save('alice', body)).settings).toEqual(body);
      await expect(controller.save('bob', body)).rejects.toThrow(
        /codex has no credential for you.*\/connections#codex/,
      );
      expect(await repo.read('bob')).toBeNull();
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

  it('refuses a level the runtime does not declare for the model, naming the agent', async () => {
    const { app, repo, controller } = await world();
    try {
      const body = { agents: { main: { plan: [{ runtime: 'cursor', model: 'grok', effort: 'xhigh' }] } } };
      await expect(controller.save('alice', body)).rejects.toThrow(/plan.*cursor:grok:xhigh/);
      const word = { agents: { main: { plan: [{ runtime: 'claude', model: 'opus', effort: 'ultra' }] } } };
      await expect(controller.save('alice', word)).rejects.toThrow(/claude:opus.*unknown effort/);
      expect(await repo.read('alice')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('lists the levels per model and stores a level the runtime declares', async () => {
    const { app, controller } = await world();
    try {
      const view = await controller.read('alice');
      const claude = view.runtimes.find((entry) => entry.runtime === 'claude');
      expect(claude?.efforts.opus).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      const body = { agents: { main: { plan: [{ runtime: 'claude', model: 'opus', effort: 'high' }] } } };
      expect((await controller.save('alice', body)).settings).toEqual(body);
    } finally {
      await app.close();
    }
  });

  it("offers the priced models of a connected runtime after env's, and accepts them", async () => {
    const { app, root, controller } = await world();
    try {
      await cachePrices(root, 'claude', ['opus', 'priced-new']);
      const view = await controller.read('alice');
      const claude = view.runtimes.find((entry) => entry.runtime === 'claude')?.models ?? [];
      expect(claude).toContain('priced-new');
      expect(claude.indexOf('opus')).toBeLessThan(claude.indexOf('priced-new'));
      expect(claude.filter((model) => model === 'opus')).toHaveLength(1);
      const body = { agents: { main: { plan: [{ runtime: 'claude', model: 'priced-new' }] } } };
      expect((await controller.save('alice', body)).settings).toEqual(body);
      const other = { agents: { main: { plan: [{ runtime: 'claude', model: 'in-neither' }] } } };
      await expect(controller.save('alice', other)).rejects.toThrow(/claude:in-neither.*unknown model/);
    } finally {
      await app.close();
    }
  });

  it("lists and accepts env's models only, and says so, when no price table can be read", async () => {
    const { app, controller } = await world();
    try {
      const view = await controller.read('alice');
      expect(view.modelsLimited).toBe(true);
      expect(view.runtimes.find((entry) => entry.runtime === 'cursor')?.models).toEqual(['grok']);
      const body = { agents: { main: { plan: [{ runtime: 'cursor', model: 'grok' }] } } };
      expect((await controller.save('alice', body)).settings).toEqual(body);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['an empty list', { agents: { main: { plan: [] } } }],
    ['an unknown role', { agents: { main: { chat: [{ runtime: 'claude', model: 'opus' }] } } }],
    ['an unknown tier', { agents: { side: {} } }],
    ['a personal split', { split: true }],
    ['an unknown key', { theme: 'dark' }],
  ])('refuses %s', async (_name, body) => {
    const { app, repo, controller } = await world();
    try {
      await expect(controller.save('alice', body)).rejects.toThrow(BadRequestException);
      if ('split' in body) {
        await expect(controller.save('alice', body)).rejects.toThrow('"split"');
      }
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
      expect(view.runtimes.map((entry) => entry.runtime)).toEqual(['cursor', 'claude']);
      expect(() => controller.save('machine', MINE)).toThrow(ForbiddenException);
    } finally {
      await app.close();
    }
  });

  it('shows the defaults of agents that name a level while their model list is not loaded', async () => {
    const levels = {
      CURSOR_API_KEY: '',
      AGENTS_PLAN: 'cursor:grok:high',
      AGENTS_IMPLEMENT: 'cursor:grok:high',
      AGENTS_REVIEW: 'cursor:grok:high',
    };
    const { app, controller, credentials } = await world(levels);
    try {
      expect(runtimeFor('cursor').listLoaded()).toBe(false);
      const view = await controller.read('alice');
      expect(view.defaults.agents.main.plan).toEqual(['cursor:grok:high']);
      expect(view.runtimes.map((entry) => entry.runtime)).not.toContain('cursor');
      const cursor = fakeConnection({ id: 'cursor', fields: ['CURSOR_API_KEY'] });
      await credentials.store(cursor, 'alice', { CURSOR_API_KEY: 'crsr-alice-1234' }, null);
      const connected = await controller.read('alice');
      expect(connected.runtimes.find((entry) => entry.runtime === 'cursor')?.models).toContain('grok');
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
      expect(view.server.find((entry) => entry.name === 'CHECKS_PARALLEL')?.description).toBe(
        'Check commands that run at once on the whole server',
      );
      expect(named.MAX_RUN_USD).toBe(String(testEnv().MAX_RUN_USD));
      expect(JSON.stringify(view)).not.toMatch(/sk-secret-anthropic|top-secret-value/);
    } finally {
      await app.close();
    }
  });

  it('shows where each setting comes from, with secrets still masked', async () => {
    const sources = new SettingSources({
      MAX_RUN_USD: 'environment',
      SWARMLOOP_SECRET: '.env',
      PROJECT_HOSTS_ALLOW: '.env',
      SANDBOX_EGRESS: 'default',
    });
    const { app, controller } = await world({}, sources);
    try {
      const server = (await controller.read('alice')).server;
      const found = (name: string) => server.find((entry) => entry.name === name);
      expect(found('MAX_RUN_USD')?.source).toBe('environment');
      expect(found('SANDBOX_EGRESS')?.source).toBe('default');
      expect(found('PROJECT_HOSTS_ALLOW')?.source).toBe('.env');
      expect(found('SWARMLOOP_SECRET')).toMatchObject({ source: '.env', value: 'set' });
      expect(found('SWARMLOOP_TOKEN')).toMatchObject({ source: 'default', value: 'not set' });
    } finally {
      await app.close();
    }
  });

  it('shows the source of each boot on its own', async () => {
    const { app, repo, root, credentials } = await world();
    const file = join(root, 'sources.env');
    await writeFile(file, 'MAX_RETURNS=7\n');
    const first = await Test.createTestingModule({ imports: [SwarmloopConfigModule.forRoot(file, {})] }).compile();
    const second = await Test.createTestingModule({
      imports: [SwarmloopConfigModule.forRoot(file, { MAX_RETURNS: '9' })],
    }).compile();
    try {
      const sourceOf = async (module: typeof first) => {
        const service = new SettingsService(
          module.get(AppConfig),
          repo,
          new SystemClock(),
          credentials,
          module.get(SettingSources),
        );
        return (await service.view('alice')).server.find((entry) => entry.name === 'MAX_RETURNS');
      };
      expect(await sourceOf(first)).toMatchObject({ source: '.env', value: '7' });
      expect(await sourceOf(second)).toMatchObject({ source: 'environment', value: '9' });
    } finally {
      await second.close();
      await first.close();
      await app.close();
    }
  });
});
