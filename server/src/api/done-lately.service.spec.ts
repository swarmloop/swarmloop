import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { DONE_SHOWN } from '../contract/overview-done';
import { DoneLatelyController } from './done-lately.controller';
import { doneLately, seedAcceptedMilestone, seedFinished, seedFinishedList } from './done-lately.spec-helpers';
import { meterDatabase } from './sqlite-meter.spec-helpers';
import { seededBoot } from './runs-boot.spec-helpers';

type App = Awaited<ReturnType<typeof seededBoot>>;

async function withApp(body: (app: App) => Promise<void>): Promise<void> {
  const app = await seededBoot(await mkdtemp(join(tmpdir(), 'swarmloop-done-lately-')));
  try {
    await body(app);
  } finally {
    await app.close();
  }
}

/** The items the service answers for what is seeded. */
async function itemsOf(app: App) {
  const { service, close } = doneLately(app);
  try {
    return await service.items();
  } finally {
    close();
  }
}

describe('DoneLatelyService', () => {
  it('answers five items of 300 finished runs in finish order, with the milestone once and each cost from the log', () =>
    withApp(async (app) => {
      await seedFinishedList(app, 300);

      const items = await itemsOf(app);

      expect(items.map((item) => item.key)).toEqual(['created-first', 'shop/1', 'epic-1', 'plain-293', 'plain-292']);
      expect(items.map((item) => item.usd)).toEqual([9, 7, 6, 0.5, 0.5]);
      const milestone = items[1];
      expect(milestone).toMatchObject({
        milestone: true,
        link: { backlog: 'shop' },
        runKeys: ['task-a', 'task-b', 'task-c'],
        durationMs: 6 * 3_600_000,
      });
      expect(milestone.run.key).toBe('task-c');
      expect(items.filter((item) => item.key.startsWith('task-'))).toEqual([]);
      expect(items[2]).toMatchObject({ milestone: false, link: { run: 'epic-1' }, runKeys: ['epic-1'] });
    }));

  it('picks by finish time, not creation order, and not by later unrelated activity', () =>
    withApp(async (app) => {
      await seedFinished(app, 'new-created', {
        at: '2026-01-02T00:00:00.000Z',
        createdAt: '2026-01-05T00:00:00.000Z',
      });
      await seedFinished(app, 'old-created', {
        at: '2026-01-04T00:00:00.000Z',
        createdAt: '2025-12-01T00:00:00.000Z',
        updatedAt: '2025-12-02T00:00:00.000Z',
      });

      expect((await itemsOf(app)).map((item) => item.key)).toEqual(['old-created', 'new-created']);
    }));

  it('finds a run finished lately beyond the first page of the list', () =>
    withApp(async (app) => {
      for (let index = 0; index < 25; index++) {
        await seedFinished(app, `early-${index}`, { at: '2026-01-01T00:00:00.000Z' });
      }
      await seedFinished(app, 'late-1', { at: '2026-02-01T00:00:00.000Z', createdAt: '2025-01-01T00:00:00.000Z' });

      expect((await itemsOf(app))[0].key).toBe('late-1');
    }));

  it('finds a run finished last that was created first, past the fifth page', () =>
    withApp(async (app) => {
      for (let index = 0; index < 110; index++) {
        await seedFinished(app, `early-${index}`, { at: '2026-01-01T00:00:00.000Z' });
      }
      await seedFinished(app, 'first-made', { at: '2026-03-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z' });

      expect((await itemsOf(app))[0].key).toBe('first-made');
    }));

  it('shows an accepted milestone once, with its cost, returns and elapsed time, and not its task runs', () =>
    withApp(async (app) => {
      await seedFinished(app, 'task-a', {
        at: '2026-03-01T10:00:00.000Z',
        createdAt: '2026-03-01T08:00:00.000Z',
        usd: 2,
      });
      await seedFinished(app, 'task-b', {
        at: '2026-03-01T12:00:00.000Z',
        createdAt: '2026-03-01T09:00:00.000Z',
        usd: 3,
      });
      await seedAcceptedMilestone(app, 'shop', 3, ['task-a', 'task-b', 'task-b']);

      const items = await itemsOf(app);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        key: 'shop/3',
        title: 'Checkout',
        link: { backlog: 'shop' },
        runKeys: ['task-a', 'task-b'],
        durationMs: 4 * 3_600_000,
        usd: 5,
        milestone: true,
      });
    }));

  it('answers the same items from the route as from the service', () =>
    withApp(async (app) => {
      await seedFinishedList(app, 12);
      const { service, close } = doneLately(app);
      try {
        expect(await new DoneLatelyController(service).list()).toEqual(await service.items());
      } finally {
        close();
      }
    }));

  it('runs the same number of statements for 30 and for 300 finished runs, and answers at most five items', async () => {
    const counts: number[] = [];
    for (const total of [30, 300]) {
      await withApp(async (app) => {
        const meter = meterDatabase(app.get(DataSource));
        await seedFinishedList(app, total);
        const { service, close } = doneLately(app);
        try {
          await service.items();
          const read = await meter.measure(() => service.items());
          expect(read.result.length).toBeLessThanOrEqual(DONE_SHOWN);
          counts.push(read.statements);
        } finally {
          close();
        }
      });
    }

    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(counts[0]);
  }, 60_000);
});
