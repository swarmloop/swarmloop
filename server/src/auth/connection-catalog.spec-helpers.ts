import { EventEmitter } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { SwarmloopConfigModule } from '../config/config.module';
import { Clock } from '../core/clock';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { HistoryModule } from '../history/history.module';
import type { Connection } from '../integrations/connection';
import { SandboxService } from '../sandbox/sandbox.service';
import { AuthService } from './auth.service';
import { CONNECTIONS } from './connection-catalog';
import { ConnectionCatalogModule } from './connection-catalog.module';

/** The settings the server needs to start, with the given ones replacing the defaults. */
function envFile(root: string, overrides: Record<string, string>): string {
  const defaults: Record<string, string> = {
    REQUIREMENTS_VIA: 'direct',
    ISSUE_TRACKER: 'jira',
    JIRA_BASE_URL: '',
    JIRA_EMAIL: '',
    JIRA_API_TOKEN: '',
    GITLAB_BASE_URL: '',
    GITLAB_TOKEN: '',
    GITHUB_BASE_URL: '',
    GITHUB_TOKEN: '',
    CURSOR_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    MAX_AGENT_CALLS: '20',
    MAX_RETURNS: '3',
    MAX_LAUNCHES: '3',
    MAX_RUN_USD: '25',
    IDLE_TIMEOUT_MS: '900000',
    TICK_MS: '15000',
    REQUIREMENTS_TIMEOUT_MS: '600000',
    RESEARCH_TIMEOUT_MS: '900000',
    PLAN_TIMEOUT_MS: '1200000',
    IMPLEMENT_TIMEOUT_MS: '1800000',
    CODE_REVIEW_TIMEOUT_MS: '900000',
    MERGE_REQUEST_TIMEOUT_MS: '600000',
    PIPELINE_TIMEOUT_MS: '1800000',
    PIPELINE_START_TIMEOUT_MS: '180000',
    AGENTS_PLAN: 'cursor:opus-5.5-extra-high',
    AGENTS_IMPLEMENT: 'cursor:grok-4.7',
    AGENTS_REVIEW: 'cursor:opus-5.5-extra-high',
    EPIC_EFFORT: '',
    SPLIT: 'off',
    SWARMLOOP_API_PORT: '0',
    SWARMLOOP_API_HOST: '127.0.0.1',
    SWARMLOOP_ROOT: root,
    SWARMLOOP_TOKEN: 'test-machine-token',
  };
  return `${Object.entries({ ...defaults, ...overrides })
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`;
}

export interface Started {
  app: INestApplication;
  root: string;
  url: string;
  clock: FakeClock;
  close(): Promise<void>;
}

/** The catalog over HTTP. The actor is the `x-actor` header, in place of a session: no header is nobody. */
export async function start(
  env: Record<string, string>,
  connections?: Connection[],
  models = '',
  cli?: object,
): Promise<Started> {
  const root = await mkdtemp(join(tmpdir(), 'connection-catalog-'));
  await writeFile(join(root, '.env'), envFile(root, env));
  const clock = new FakeClock();
  const sandbox = {
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(models));
        child.emit('close', 0);
      });
      return Promise.resolve(child);
    },
  };
  let builder = Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), HistoryModule, ConnectionCatalogModule],
  })
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(SandboxService)
    .useValue(cli ?? sandbox)
    .overrideProvider(AuthService)
    .useValue({
      check: (headers: Record<string, string>) => ({ allowed: true, actor: headers['x-actor'] ?? null }),
    });
  if (connections) {
    builder = builder.overrideProvider(CONNECTIONS).useValue(connections);
  }
  const app = (await builder.compile()).createNestApplication();
  await app.listen(0, '127.0.0.1');
  const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
  return {
    app,
    root,
    clock,
    url: `http://127.0.0.1:${port}/connections/integrations`,
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export const call = (url: string, actor: string | null, method = 'GET', body?: unknown) =>
  fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(actor ? { 'x-actor': actor } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
