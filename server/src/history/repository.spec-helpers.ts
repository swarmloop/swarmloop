import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { Clock } from '../core/clock';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { HistoryModule } from './history.module';
import { LiveModule } from '../live/live.module';
import { seedMigratedDatabase } from '../testing/migrated-database.spec-helpers';
import type { VisitDraft } from './visit';
import { AgentCallRepository } from './agent-call.repository';

export async function repositoryDatabase() {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-repository-'));
  seedMigratedDatabase(root);
  const clock = new FakeClock();
  const config = new AppConfig(testEnv({ SWARMLOOP_ROOT: root }));

  @Global()
  @Module({
    providers: [
      { provide: AppConfig, useValue: config },
      { provide: Clock, useValue: clock },
    ],
    exports: [AppConfig, Clock],
  })
  class RepositoryConfigModule {}

  try {
    const app = await Test.createTestingModule({
      imports: [RepositoryConfigModule, LiveModule, HistoryModule],
    }).compile();
    return {
      app,
      root,
      clock,
      config,
      async close() {
        try {
          await app.close();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Seeds one finished call of the log, as the launcher writes it, and returns its id for a visit's `callIds`. */
export async function repositoryCall(app: {
  get(token: typeof AgentCallRepository): AgentCallRepository;
}): Promise<number> {
  const calls = app.get(AgentCallRepository);
  const id = await calls.open({
    kind: 'call',
    startedAt: '2026-01-01T00:00:00.000Z',
    chatId: 'chat-1',
    resumed: false,
    runtime: 'claude',
    model: 'test-model',
    requestText: 'request',
  });
  await calls.finish(id, {
    endKind: 'done',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    responseText: 'response',
  });
  return id;
}

export function repositoryVisit(): VisitDraft {
  return {
    step: 'code-review',
    model: 'test-model',
    mode: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    status: 'done',
    exitCode: 0,
    killReason: null,
    tokensIn: 2,
    tokensOut: 3,
    usd: 0,
    samples: [{ sampledAt: '2026-01-01T00:00:00.000Z', cpuPercent: 10, rssBytes: 100, source: 'agent' }],
    httpCalls: [],
    document: { kind: 'review_report', fileName: 'report.md', body: 'first report' },
    resumed: false,
  };
}
