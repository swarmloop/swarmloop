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
import type { VisitDraft } from './visit';

export async function repositoryDatabase() {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-repository-'));
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
    const app = await Test.createTestingModule({ imports: [RepositoryConfigModule, HistoryModule] }).compile();
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
    samples: [{ sampledAt: '2026-01-01T00:00:00.000Z', cpuPercent: 10, rssBytes: 100 }],
    exchange: {
      model: 'test-model',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      requestText: 'request',
      responseText: 'response',
      chatId: 'chat-1',
      resumed: false,
      killReason: null,
    },
    httpCalls: [],
    document: { kind: 'review_report', fileName: 'report.md', body: 'first report' },
    resumed: false,
  };
}
