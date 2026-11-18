import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { SlowRequestEntity } from './server-stall.entities';
import type { ServerStallDraft } from './server-stall.repository';
import { ServerStallRepository, SlowRequestRepository } from './server-stall.repository';
import { repositoryDatabase } from './repository.spec-helpers';

function stall(startedAt: string): ServerStallDraft {
  return {
    startedAt,
    durationMs: 12000,
    kind: 'server-blocked',
    runningAgents: 2,
    runningChecks: 1,
    runningSetups: 0,
    cpuPercent: 250.5,
    memoryBytes: 1024,
    vmCpus: 4,
    vmMemoryBytes: 8192,
    entered: 'GET /runs',
  };
}

describe('ServerStallRepository', () => {
  it('returns the stalls from a time on, oldest first', async () => {
    const db = await repositoryDatabase();
    try {
      const stalls = db.app.get(ServerStallRepository);
      await stalls.record(stall('2026-11-17T12:00:00.000Z'));
      await stalls.record(stall('2026-11-17T10:00:00.000Z'));
      await stalls.record(stall('2026-11-17T08:00:00.000Z'));
      const rows = await stalls.since('2026-11-17T10:00:00.000Z');
      expect(rows.map((row) => row.startedAt)).toEqual(['2026-11-17T10:00:00.000Z', '2026-11-17T12:00:00.000Z']);
      expect(rows[0]).toMatchObject({ kind: 'server-blocked', vmCpus: 4, entered: 'GET /runs' });
    } finally {
      await db.close();
    }
  });
});

describe('SlowRequestRepository', () => {
  it('keeps one row per route with count, total and longest', async () => {
    const db = await repositoryDatabase();
    try {
      const slow = db.app.get(SlowRequestRepository);
      await slow.add('GET /api/stats', 1500, '2026-11-17T10:00:00.000Z');
      await slow.add('GET /api/stats', 2500, '2026-11-17T10:01:00.000Z');
      await slow.add('GET /api/stats', 1200, '2026-11-17T10:02:00.000Z');
      const rows = await db.app.get<Repository<SlowRequestEntity>>(getRepositoryToken(SlowRequestEntity)).find();
      expect(rows).toEqual([
        { route: 'GET /api/stats', count: 3, totalMs: 5200, longestMs: 2500, lastAt: '2026-11-17T10:02:00.000Z' },
      ]);
    } finally {
      await db.close();
    }
  });
});
