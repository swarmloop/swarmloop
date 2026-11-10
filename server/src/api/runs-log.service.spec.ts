import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RunEntity } from '../history/entities';
import { repositoryVisit } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { boot, save } from '../testing/runs.spec-helpers';
import { RunQueriesService } from './run-queries.service';

async function withApp(
  test: (queries: RunQueriesService, app: Awaited<ReturnType<typeof boot>>, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-log-'));
  const app = await boot(root);
  try {
    await mkdir(join(root, 'data'), { recursive: true });
    await test(app.get(RunQueriesService), app, root);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function attempt(visits: VisitRepository, run: RunEntity, attemptId: string, step: string): Promise<void> {
  const stat = await visits.finishVisit(run, { ...repositoryVisit(), step });
  stat.attemptId = attemptId;
  await visits.saveStat(stat);
}

const log = (root: string, name: string, body: string) => writeFile(join(root, 'data', name), body);

describe('step log api', () => {
  it('reads the file of an attempt, the newest file without one, and a reviewer log of the parent attempt', async () => {
    await withApp(async (queries, app, root) => {
      const run = await save(app.get(RunRepository), 'proj-1', 'implement', 'waiting');
      const visits = app.get(VisitRepository);
      await attempt(visits, run, 'att-1', 'implement');
      await attempt(visits, run, 'rev-1', 'code-review');
      await log(root, 'proj-1-implement-att-1-output.txt', 'first\n');
      await log(root, 'proj-1-code-review-security-rev-1-output.txt', 'reviewer\n');
      expect(await queries.stepLog('proj-1', 'implement', 'att-1')).toBe('first\n');
      expect(await queries.stepLog('proj-1', 'implement', null)).toBe('first\n');
      expect(await queries.stepLog('proj-1', 'code-review-security', 'rev-1')).toBe('reviewer\n');
    });
  });

  it('reads the active attempt of the running step and redacts tokens', async () => {
    await withApp(async (queries, app, root) => {
      const runs = app.get(RunRepository);
      const run = await save(runs, 'proj-2', 'plan', 'running');
      run.activeAttempt = 'live-1';
      await runs.saveRun(run);
      await log(root, 'proj-2-plan-live-1-output.txt', 'push ghp_abcdef123456 done\n');
      expect(await queries.stepLog('proj-2', 'plan', 'live-1')).toBe('push *** done\n');
    });
  });

  it('answers an empty file with an empty log', async () => {
    await withApp(async (queries, app, root) => {
      await save(app.get(RunRepository), 'proj-3', 'plan', 'waiting');
      await log(root, 'proj-3-plan-output.txt', '');
      expect(await queries.stepLog('proj-3', 'plan', null)).toBe('');
    });
  });

  it('refuses paths, unknown runs, unknown steps, foreign attempts and missing files with 404', async () => {
    await withApp(async (queries, app, root) => {
      const run = await save(app.get(RunRepository), 'proj-4', 'implement', 'waiting');
      await attempt(app.get(VisitRepository), run, 'att-1', 'implement');
      await log(root, 'proj-4-implement-att-1-output.txt', 'x');
      await log(root, 'proj-4-plan-att-1-output.txt', 'secret');
      const refused = [
        ['../..', 'plan', null],
        ['/etc', 'plan', null],
        ['nope', 'plan', null],
        ['proj-4', '../../etc/passwd', null],
        ['proj-4', '/etc/passwd', null],
        ['proj-4', 'swarmloop', null],
        ['proj-4', 'implement', '../att-1'],
        ['proj-4', 'implement', '/etc/passwd'],
        ['proj-4', 'plan', 'att-1'],
        ['proj-4', 'commit', null],
      ] as const;
      for (const [key, step, attempt] of refused) {
        await expect(queries.stepLog(key, step, attempt)).rejects.toBeInstanceOf(NotFoundException);
      }
    });
  });
});
