import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ResourceSampleEntity } from './entities';
import type { SampleDraft } from './visit';
import { CheckCommandRepository } from './check-command.repository';
import { FootprintRepository } from './footprint.repository';
import { repositoryDatabase, repositoryVisit } from './repository.spec-helpers';
import { RunRepository } from './run.repository';
import { VisitRepository } from './visit.repository';

type Database = Awaited<ReturnType<typeof repositoryDatabase>>;

const sample = (source: string | null, cpuPercent: number, rssBytes: number): SampleDraft =>
  ({ sampledAt: '2026-01-01T00:00:00.000Z', cpuPercent, rssBytes, source }) as SampleDraft;

/** One finished visit of a run with the given samples, its runtime and the attempt it ran as. */
async function visit(
  db: Database,
  runKey: string,
  samples: SampleDraft[],
  extra: { runtime?: string | null; attemptId?: string | null; projects?: string } = {},
): Promise<number> {
  const run = await db.app.get(RunRepository).begin(runKey, 'implement');
  const stat = await db.app
    .get(VisitRepository)
    .finishVisit(run, { ...repositoryVisit(), runtime: extra.runtime ?? null, samples });
  const source = db.app.get(DataSource);
  await source.query('UPDATE step_stats SET attempt_id = ? WHERE id = ?', [extra.attemptId ?? null, stat.id]);
  if (extra.projects !== undefined) {
    await source.query('UPDATE runs SET projects = ? WHERE id = ?', [extra.projects, run.id]);
  }
  return run.id;
}

async function command(db: Database, runId: number, attemptId: string, index: number, text: string, name?: string) {
  await db.app
    .get(CheckCommandRepository)
    .add({ runId, attemptId, repo: 'app', command: text, commandIndex: index, name: name ?? null });
}

describe('FootprintRepository', () => {
  it('reads the peak of each piece per check command name, matched by the index of the same attempt', async () => {
    const db = await repositoryDatabase();
    try {
      const runId = await visit(db, 'run-1', [sample('0', 50, 100), sample('0', 300, 900), sample('1', 700, 5000)], {
        attemptId: 'a1',
      });
      await command(db, runId, 'a1', 0, 'npm test', 'unit');
      await command(db, runId, 'a1', 1, 'npm run lint');
      // The same index of another attempt is another command.
      const otherId = await visit(db, 'run-2', [sample('0', 900, 9000)], { attemptId: 'a2' });
      await command(db, otherId, 'a2', 0, 'make', 'build');
      const footprints = db.app.get(FootprintRepository);
      expect(await footprints.peaks('check', 'unit')).toEqual([{ cpuPercent: 300, rssBytes: 900 }]);
      expect(await footprints.peaks('check', 'npm run lint')).toEqual([{ cpuPercent: 700, rssBytes: 5000 }]);
      expect(await footprints.peaks('check', 'build')).toEqual([{ cpuPercent: 900, rssBytes: 9000 }]);
      expect(await footprints.peaks('check', 'npm test')).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('never reads an agent or setup sample as the check at index 0', async () => {
    const db = await repositoryDatabase();
    try {
      const runId = await visit(db, 'run-1', [sample('agent', 100, 100), sample('setup', 100, 100)], {
        attemptId: 'a1',
      });
      await command(db, runId, 'a1', 0, 'npm test');
      expect(await db.app.get(FootprintRepository).peaks('check', 'npm test')).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('reads setups of runs with exactly that one repository', async () => {
    const db = await repositoryDatabase();
    try {
      await visit(db, 'run-1', [sample('setup', 200, 2000), sample('setup', 100, 3000)], { projects: 'app\n' });
      await visit(db, 'run-2', [sample('setup', 800, 8000)], { projects: 'app\nweb\n' });
      await visit(db, 'run-3', [sample('agent', 800, 8000)], { projects: 'app\n' });
      expect(await db.app.get(FootprintRepository).peaks('setup', 'app')).toEqual([
        { cpuPercent: 200, rssBytes: 3000 },
      ]);
    } finally {
      await db.close();
    }
  });

  it('reads agents by runtime, counting a sample without a source as the agent', async () => {
    const db = await repositoryDatabase();
    try {
      await visit(db, 'run-1', [sample('agent', 100, 1000), sample('agent', 150, 800)], { runtime: 'codex' });
      await visit(db, 'run-2', [sample(null, 400, 4000)], { runtime: 'codex' });
      await visit(db, 'run-3', [sample('agent', 900, 9000)], { runtime: 'claude' });
      await visit(db, 'run-4', [sample('server', 900, 9000)], { runtime: 'codex' });
      expect(await db.app.get(FootprintRepository).peaks('agent', 'codex')).toEqual([
        { cpuPercent: 400, rssBytes: 4000 },
        { cpuPercent: 150, rssBytes: 1000 },
      ]);
    } finally {
      await db.close();
    }
  });

  it('keeps the last 50 pieces, newest first, and gives fewer than 5 peaks for fewer than 5 pieces', async () => {
    const db = await repositoryDatabase();
    try {
      const footprints = db.app.get(FootprintRepository);
      for (let index = 0; index < 3; index++) {
        await visit(db, `run-${index}`, [sample('agent', index, index)], { runtime: 'codex' });
      }
      expect(await footprints.peaks('agent', 'codex')).toHaveLength(3);
      for (let index = 3; index < 55; index++) {
        await visit(db, `run-${index}`, [sample('agent', index, index)], { runtime: 'codex' });
      }
      const peaks = await footprints.peaks('agent', 'codex');
      expect(peaks).toHaveLength(50);
      expect(peaks[0]).toEqual({ cpuPercent: 54, rssBytes: 54 });
      expect(peaks.at(-1)).toEqual({ cpuPercent: 5, rssBytes: 5 });
    } finally {
      await db.close();
    }
  });

  it('reads the samples of each kind through their index, never by scanning all of them', async () => {
    const db = await repositoryDatabase();
    try {
      const runId = await visit(db, 'run-1', [sample('0', 1, 1), sample('setup', 1, 1)], {
        runtime: 'codex',
        attemptId: 'a1',
        projects: 'app\n',
      });
      await command(db, runId, 'a1', 0, 'npm test');
      const samples = db.app.get(getRepositoryToken(ResourceSampleEntity));
      const asked: { sql: string; params: string[] }[] = [];
      const query = samples.query.bind(samples);
      jest.spyOn(samples, 'query').mockImplementation((...args: unknown[]) => {
        const [sql, params] = args as [string, string[] | undefined];
        asked.push({ sql, params: params ?? [] });
        return query(sql, params);
      });
      const footprints = db.app.get(FootprintRepository);
      await footprints.peaks('agent', 'codex');
      await footprints.peaks('setup', 'app');
      await footprints.peaks('check', 'npm test');
      expect(asked).toHaveLength(3);
      for (const { sql, params } of asked) {
        const plan: { detail: string }[] = await query(`EXPLAIN QUERY PLAN ${sql}`, params);
        const details = plan.map((row) => row.detail);
        expect(details.filter((detail) => /^SCAN (r|resource_samples|c|check_commands)\b/.test(detail))).toEqual([]);
        // The walk over `step_stats` has a ceiling: it only runs inside the limited subquery.
        expect(details).toContain('CO-ROUTINE s');
      }
    } finally {
      await db.close();
    }
  });
});
