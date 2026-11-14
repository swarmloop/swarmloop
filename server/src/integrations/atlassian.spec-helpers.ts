import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ConnectionCatalog } from '../auth/connection-catalog';
import { ConnectionCatalogModule } from '../auth/connection-catalog.module';
import { PersonalCredentials } from '../auth/personal-credentials.service';
import { AppConfig } from '../config/env';
import type { SwarmloopEnv } from '../config/env';
import { Clock, SystemClock } from '../core/clock';
import { testEnv } from '../config/env.spec-helpers';
import { HistoryModule } from '../history/history.module';
import { SandboxService } from '../sandbox/sandbox.service';

export interface CatalogApp {
  catalog: ConnectionCatalog;
  personal: PersonalCredentials;
  rows(): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** The real connection catalog over a fresh database, with the sandbox out of the way: Jira and Confluence tests use plain HTTP. */
export async function startCatalog(env: Partial<SwarmloopEnv> = {}): Promise<CatalogApp> {
  const root = await mkdtemp(join(tmpdir(), 'atlassian-catalog-'));
  const providers = [
    { provide: AppConfig, useValue: new AppConfig(testEnv({ SWARMLOOP_ROOT: root, ...env })) },
    { provide: Clock, useValue: new SystemClock() },
  ];
  @Global()
  @Module({ providers, exports: [AppConfig, Clock] })
  class SpecConfigModule {}
  const module: TestingModule = await Test.createTestingModule({
    imports: [SpecConfigModule, HistoryModule, ConnectionCatalogModule],
  })
    .overrideProvider(SandboxService)
    .useValue({})
    .compile();
  await module.init();
  return {
    catalog: module.get(ConnectionCatalog),
    personal: module.get(PersonalCredentials),
    rows: () => module.get(DataSource).query<Record<string, unknown>[]>('SELECT * FROM integration_secrets'),
    close: async () => {
      await module.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
