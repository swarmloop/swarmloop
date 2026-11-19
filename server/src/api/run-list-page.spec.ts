import { BadRequestException } from '@nestjs/common';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { filterRuns } from '../contract/run-list';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { pageOf } from './run-list-page';
import { freshView, seedRuns, SEEDED } from './run-list-rows.spec-helpers';
import { seededBoot } from './runs-boot.spec-helpers';

async function withApp(body: (app: Awaited<ReturnType<typeof seededBoot>>) => Promise<void>): Promise<void> {
  const app = await seededBoot(await mkdtemp(join(tmpdir(), 'swarmloop-run-list-page-')));
  try {
    await body(app);
  } finally {
    await app.close();
  }
}

/** Makes every plain run done, so the done part has many top-level runs. */
async function finishPlain(app: Awaited<ReturnType<typeof seededBoot>>, total: number): Promise<void> {
  const runs = app.get(RunRepository);
  for (let n = 1; n <= total - 4; n++) {
    const run = (await runs.findRun(`plain-${n}`))!;
    writeRunState(run, { status: 'done', currentStep: 'commit' });
    await runs.saveRun(run);
  }
}

describe('pageOf', () => {
  it('answers every active top-level run with its subtasks', () =>
    withApp(async (app) => {
      await seedRuns(app, 50);
      const { runs } = await freshView(app);
      const page = pageOf(runs, { part: 'active', q: '' });
      expect(page.next).toBeNull();
      expect(page.runs.map((run) => run.key)).toEqual(filterRuns(runs, '', 'active').visible.map((run) => run.key));
      expect(page.runs.map((run) => run.key)).toEqual(
        expect.arrayContaining([SEEDED.parent, SEEDED.done, SEEDED.open]),
      );
    }));

  it('pages done runs 20 at a time, newest first, with none twice or missing', () =>
    withApp(async (app) => {
      await seedRuns(app, 64);
      await finishPlain(app, 64);
      const { runs } = await freshView(app);
      const expected = filterRuns(runs, '', 'done').visible.map((run) => run.key);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = pageOf(runs, { part: 'done', q: '', cursor });
        seen.push(...page.runs.map((run) => run.key));
        pages += 1;
        cursor = page.next ?? undefined;
      } while (cursor);
      expect(pages).toBe(Math.ceil(60 / 20));
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(seen.length);
    }));

  it('matches the text as filterRuns does and counts every part', () =>
    withApp(async (app) => {
      await seedRuns(app, 30);
      const { runs } = await freshView(app);
      const page = pageOf(runs, { part: 'all', q: 'plain-1' });
      const expected = filterRuns(runs, 'plain-1', 'all');
      expect(page.runs).toEqual(expected.visible.slice(0, page.runs.length));
      expect(page.otherMatches).toBe(expected.otherMatches);
      expect(page.counts).toEqual(filterRuns(runs, '', 'all').counts);
    }));

  it('answers a cursor this list did not give with 400', () =>
    withApp(async (app) => {
      await seedRuns(app, 10);
      const { runs } = await freshView(app);
      for (const cursor of ['nonsense', Buffer.from('{"createdAt":1}').toString('base64url')]) {
        expect(() => pageOf(runs, { part: 'done', q: '', cursor })).toThrow(BadRequestException);
      }
    }));
});
