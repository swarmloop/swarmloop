import 'reflect-metadata';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { repositoryVisit } from '../history/repository.spec-helpers';
import { EventRepository } from '../history/event.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { boot, save } from '../testing/runs.spec-helpers';
import { RunQueriesService } from './run-queries.service';

const LINE = `${'x'.repeat(98)}\n`;
const TEN_MB_LOG = LINE.repeat(Math.ceil((10 * 1024 * 1024) / LINE.length));
const MIB = 1024 * 1024;

async function withBigRun(
  test: (queries: RunQueriesService, app: Awaited<ReturnType<typeof boot>>, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-answer-size-'));
  const app = await boot(root);
  try {
    const run = await save(app.get(RunRepository), 'proj-big', 'implement', 'waiting');
    const stat = await app.get(VisitRepository).finishVisit(run, { ...repositoryVisit(), step: 'implement' });
    stat.attemptId = 'att-1';
    await app.get(VisitRepository).saveStat(stat);
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data', 'proj-big-implement-att-1-output.txt'), TEN_MB_LOG);
    await test(app.get(RunQueriesService), app, root);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

const size = (answer: unknown): number => Buffer.byteLength(JSON.stringify(answer));

describe('a run with a 10 MB log', () => {
  it('answers the step with the size of the log and no body, and the route gives the whole log', async () => {
    await withBigRun(async (queries) => {
      const answer = await queries.step('proj-big', 'implement');
      expect(size(answer)).toBeLessThan(200 * 1024);
      expect(answer.visits[0]).toMatchObject({
        attemptId: 'att-1',
        logBytes: TEN_MB_LOG.length,
        logLines: TEN_MB_LOG.split('\n').length - 1,
      });
      expect(answer.visits[0].documents.map((item) => item.kind)).not.toContain('log');
      expect((await queries.stepLog('proj-big', 'implement', 'att-1')).length).toBe(TEN_MB_LOG.length);
    });
  });

  it('keeps every answer of the run API under 1 MB', async () => {
    await withBigRun(async (queries) => {
      const answers = [
        await queries.list(),
        await queries.flow('proj-big'),
        await queries.readHistory('proj-big'),
        await queries.stepEventPage('proj-big', {}),
        await queries.step('proj-big', 'implement'),
        await queries.step('proj-big', 'code-review-quality'),
        // the window reads the log by its last lines
        await queries.stepLog('proj-big', 'implement', 'att-1', { tail: '2000' }),
      ];
      for (const answer of answers) {
        expect(size(answer)).toBeLessThan(MIB);
      }
      expect(answers.at(-1)).toBe(LINE.repeat(2000));
    });
  });

  it('plans the queries of the run page with indexes', async () => {
    await withBigRun(async (_queries, app) => {
      const queries: [string, string][] = [
        ['documents', 'run_id'],
        ['documents', 'step_stat_id'],
        ['step_stats', 'run_id'],
        ['agent_exchanges', 'step_stat_id'],
        ['resource_samples', 'step_stat_id'],
        ['http_calls', 'run_id'],
        ['loop_events', 'run_id'],
        ['flows', 'run_id'],
      ];
      for (const [table, column] of queries) {
        const plan: { detail: string }[] = await app
          .get(DataSource)
          .query(`EXPLAIN QUERY PLAN SELECT * FROM "${table}" WHERE "${column}" = 1`);
        expect(plan.map((row) => row.detail).join('\n')).toContain(`USING INDEX IDX_${table}_${column}`);
      }
    });
  });

  it('keeps the stored log of a visit from before attempts in the step and history answers', async () => {
    await withBigRun(async (queries, app) => {
      const run = await save(app.get(RunRepository), 'proj-old', 'implement', 'waiting');
      await app.get(VisitRepository).finishVisit(run, {
        ...repositoryVisit(),
        step: 'implement',
        documents: [{ kind: 'log', fileName: '', body: 'old one\nold two' }],
      });
      const step = await queries.step('proj-old', 'implement');
      expect(step.visits[0].documents.map((item) => item.body)).toEqual(['old one\nold two']);
      expect(step.visits[0]).toMatchObject({ logBytes: 15, logLines: 2 });
      const history = await queries.readHistory('proj-old');
      expect(history.documents.map((item) => item.kind)).toEqual(['log']);
    });
  });

  it('marks a pipeline return that no check covers in the history', async () => {
    await withBigRun(async (queries, app) => {
      const run = await save(app.get(RunRepository), 'proj-ci', 'implement', 'waiting');
      const events = app.get(EventRepository);
      await events.recordLoop(run, 'pipeline', 1, 'CI job docker failed; no check covers it', {
        ciOnly: true,
        jobs: ['docker'],
      });
      await events.recordLoop(run, 'pipeline', 2, 'g/p lint', { ciOnly: false, jobs: ['lint'] });
      await events.recordLoop(run, 'checks', 1, 'required checks failed');
      const history = await queries.readHistory('proj-ci');
      expect(history.loops.map((loop) => loop.ciOnly)).toEqual([true, undefined, undefined]);
    });
  });

  it.each(['code-review-quality', 'code-review-security'])(
    'resolves the attempt file of the stored %s visit and serves it through the log route',
    async (step) => {
      await withBigRun(async (queries, app, root) => {
        const run = await save(app.get(RunRepository), 'proj-angle', 'implement', 'waiting');
        await app.get(VisitRepository).finishVisit(run, { ...repositoryVisit(), step });
        await writeFile(join(root, 'data', `proj-angle-${step}-att-9-output.txt`), 'one\ntwo\nthree\n');
        const visit = (await queries.step('proj-angle', step)).visits[0];
        expect(visit).toMatchObject({ attemptId: 'att-9', logBytes: 14, logLines: 3 });
        expect(await queries.stepLog('proj-angle', step, 'att-9')).toBe('one\ntwo\nthree\n');
        const history = await queries.readHistory('proj-angle');
        expect(history.stats[0]).toMatchObject({ attemptId: 'att-9', logLines: 3 });
        await expect(queries.stepLog('proj-angle', step, 'att-8')).rejects.toThrow('not an attempt');
      });
    },
  );

  it.each(['implement', 'code-review-quality'])('shows the effort a stored %s visit ran with', async (step) => {
    await withBigRun(async (queries, app) => {
      const run = await save(app.get(RunRepository), 'proj-effort', 'implement', 'waiting');
      await app
        .get(VisitRepository)
        .finishVisit(run, { ...repositoryVisit(), step, effort: 'high', effortNote: 'epic' });
      const visit = (await queries.step('proj-effort', step)).visits[0];
      expect(visit).toMatchObject({ effort: 'high', effortNote: 'epic' });
    });
  });

  it('leaves the effort out of a stored visit that ran at the default', async () => {
    await withBigRun(async (queries) => {
      const visit = (await queries.step('proj-big', 'implement')).visits[0];
      expect('effort' in visit).toBe(false);
      expect('effortNote' in visit).toBe(false);
    });
  });
});
