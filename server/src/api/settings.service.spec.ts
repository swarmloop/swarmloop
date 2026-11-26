import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { DefaultsLayout, parseDefaultsLayout } from '../config/defaults-layout';
import { testEnv } from '../config/env.spec-helpers';
import { SettingSources } from '../config/setting-sources';
import { SystemClock } from '../core/clock';
import { PersonalCredentials } from '../auth/personal-credentials.service';
import { SecretBox } from '../auth/secret-box';
import { IntegrationSecretRepository } from '../history/integration-secret.repository';
import { UserSettingRepository } from '../history/user-setting.repository';
import { seededBoot } from './runs-boot.spec-helpers';
import { SettingsService } from './settings.service';

/** A defaults.env in the file's form: a blank-line block per group, headed by its first comment line. */
const DEFAULTS_ENV = [
  '# Limits.',
  '# Maximum returns per step.',
  'MAX_RETURNS=10',
  'MAX_LAUNCHES=3',
  '',
  '# Authentication.',
  '# Personal API token.',
  'SWARMLOOP_TOKEN=',
  '# Encryption secret.',
  'SWARMLOOP_SECRET=',
  'NOT_A_SERVER_SETTING=1',
  '',
  'SWARMLOOP_API_PORT=3920',
].join('\n');

async function world(backlog = 'claude:opus') {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-settings-service-'));
  const app = await seededBoot(root);
  const config = new AppConfig(
    testEnv({
      SWARMLOOP_ROOT: root,
      ANTHROPIC_API_KEY: 'sk-secret-anthropic',
      AGENTS_PLAN: 'claude:opus',
      AGENTS_IMPLEMENT: 'claude:opus',
      AGENTS_REVIEW: 'claude:opus',
      AGENTS_BACKLOG_PLAN: backlog,
    }),
  );
  const clock = new SystemClock();
  const credentials = new PersonalCredentials(app.get(IntegrationSecretRepository), new SecretBox('k'), clock, config);
  const service = new SettingsService(
    config,
    app.get(UserSettingRepository),
    clock,
    credentials,
    new SettingSources({}),
    new DefaultsLayout(parseDefaultsLayout(DEFAULTS_ENV)),
  );
  return { app, service };
}

describe('the server list of the settings', () => {
  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
  });
  afterEach(() => jest.restoreAllMocks());

  it('follows defaults.env: its order, the group of each block and the comment above each name', async () => {
    const { app, service } = await world();
    try {
      const { server } = await service.view('alice');
      expect(server.map(({ name, group, description }) => ({ name, group, description }))).toEqual([
        { name: 'MAX_RETURNS', group: 'Limits.', description: 'Maximum returns per step.' },
        { name: 'MAX_LAUNCHES', group: 'Limits.', description: undefined },
        { name: 'SWARMLOOP_TOKEN', group: 'Authentication.', description: 'Personal API token.' },
        { name: 'SWARMLOOP_SECRET', group: 'Authentication.', description: 'Encryption secret.' },
        { name: 'SWARMLOOP_API_PORT', group: '', description: undefined },
      ]);
    } finally {
      await app.close();
    }
  });

  it('shows a secret as set or not set, never its value', async () => {
    const { app, service } = await world();
    try {
      const found = (await service.view('alice')).server.filter(({ secret }) => secret);
      expect(found.map(({ name, value }) => [name, value])).toEqual([
        ['SWARMLOOP_TOKEN', expect.stringMatching(/^(set|not set)$/)],
        ['SWARMLOOP_SECRET', expect.stringMatching(/^(set|not set)$/)],
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('the backlog tier of the settings', () => {
  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
  });
  afterEach(() => jest.restoreAllMocks());

  it('has the plan list of env as its default, and the main plan list when env leaves it empty', async () => {
    const own = await world('claude:opus:xhigh');
    const empty = await world('');
    try {
      expect((await own.service.view('alice')).defaults.agents.backlog).toEqual({ plan: ['claude:opus:xhigh'] });
      expect((await empty.service.view('alice')).defaults.agents.backlog).toEqual({ plan: ['claude:opus'] });
    } finally {
      await own.app.close();
      await empty.app.close();
    }
  });

  it('gives the level of each list from defaults.env, also where a list falls back to the main one', async () => {
    const own = await world('claude:opus:xhigh');
    const empty = await world('');
    try {
      const { levels } = (await own.service.view('alice')).defaults;
      expect(levels.main).toEqual({ plan: 'high', implement: 'high', review: 'high' });
      expect(levels.backlog).toEqual({ plan: 'high' });
      expect((await empty.service.view('alice')).defaults.levels.backlog).toEqual({ plan: 'high' });
    } finally {
      await own.app.close();
      await empty.app.close();
    }
  });

  it('stores and reads back a person choice for the plan role', async () => {
    const { app, service } = await world();
    try {
      const body = { agents: { backlog: { plan: [{ runtime: 'claude', model: 'opus' }] } } };
      expect((await service.save('alice', body)).settings).toEqual(body);
      expect((await service.view('alice')).settings).toEqual(body);
    } finally {
      await app.close();
    }
  });

  it('refuses the implement and review roles of the backlog tier', async () => {
    const { app, service } = await world();
    try {
      for (const role of ['implement', 'review']) {
        const body = { agents: { backlog: { [role]: [{ runtime: 'claude', model: 'opus' }] } } };
        await expect(service.save('alice', body)).rejects.toThrow(BadRequestException);
      }
    } finally {
      await app.close();
    }
  });
});
