import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { SettingSources } from '../config/setting-sources';
import { SystemClock } from '../core/clock';
import { PersonalCredentials } from '../auth/personal-credentials.service';
import { SecretBox } from '../auth/secret-box';
import { IntegrationSecretRepository } from '../history/integration-secret.repository';
import { UserSettingRepository } from '../history/user-setting.repository';
import { seededBoot } from './runs-boot.spec-helpers';
import { SettingsService } from './settings.service';

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
  );
  return { app, service };
}

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
