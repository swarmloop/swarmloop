import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { CommandEntity, DocumentEntity, RunEntity } from '../history/entities';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { StatsRepository } from '../history/stats.repository';
import { StatsController } from './stats.controller';
import { meterDatabase } from './sqlite-meter.spec-helpers';
import { rangeStart } from './stats';
import { seedStatsFixture } from './stats-fixture.spec-helpers';

// Characters of string values SQLite returned to one report call over the 500-run fixture (counted with meterDatabase): 11_992_329 for the whole report, rounded up by about half.
const MAX_REPORT_CHARACTERS = 18_000_000;
// Characters of string values SQLite returned to one report call for each run of its range over the fixtures (counted with meterDatabase): at most 21_100, rounded up by about half.
const MAX_RUN_CHARACTERS = 32_000;

async function metered(count?: number) {
  const db = await repositoryDatabase();
  const data = db.app.get(DataSource);
  const meter = meterDatabase(data);
  await seedStatsFixture(data, db.clock.now(), count);
  const controller = new StatsController(db.app.get(StatsRepository), db.app.get(RunRepository), db.clock);
  return { db, data, meter, controller };
}

type Metered = Awaited<ReturnType<typeof metered>>;

/** The statements that read `table`: it follows a FROM or a JOIN, bare or quoted. */
function statementsReading(sources: string[], table: string): string[] {
  const reads = new RegExp(`\\b(FROM|JOIN)\\s+["\`]?${table}["\`]?\\b`, 'i');
  return sources.filter((source) => reads.test(source));
}

/** The runs created in the last `days` days of the database (every run for 0). */
async function runsInRange({ data, db }: Metered, days: number): Promise<number> {
  const since = rangeStart(db.clock.now(), { days, tzOffset: 0 });
  const [{ count }] = await data.query(
    `SELECT COUNT(*) AS count FROM runs${since === null ? '' : ' WHERE created_at >= ?'}`,
    since === null ? [] : [since],
  );
  return Number(count);
}

async function reports({ meter, controller }: Metered) {
  const all = await meter.measure(() => controller.report('0', '0'));
  const last30 = await meter.measure(() => controller.report(undefined, '0'));
  return { all, last30 };
}

describe('StatsController', () => {
  let full: Metered;

  beforeAll(async () => {
    full = await metered();
  }, 60_000);

  afterAll(async () => {
    await full.db.close();
  });

  it('answers the report of 500 runs with the body stored from the code before, statements that do not grow with the runs and a bounded read', async () => {
    const small = await metered(50);
    try {
      const expected = JSON.parse(readFileSync(join(__dirname, 'stats-report.expected.json'), 'utf8'));
      const big = await reports(full);
      const few = await reports(small);

      expect({ all: big.all.result, last30: big.last30.result }).toEqual(expected);
      expect(big.all.statements).toBe(few.all.statements);
      expect(big.last30.statements).toBe(few.last30.statements);
      expect(big.all.characters).toBeLessThan(MAX_REPORT_CHARACTERS);
      expect(big.last30.characters).toBeLessThan(MAX_REPORT_CHARACTERS);
    } finally {
      await small.db.close();
    }
  }, 60_000);

  it('reads more than the report ceiling when every prompt and requirements body is read whole', async () => {
    const whole = await full.meter.measure(async () => {
      await full.data.query('SELECT prompt FROM runs');
      await full.data.query("SELECT body FROM documents WHERE kind = 'requirements'");
    });

    expect(whole.characters).toBeGreaterThan(MAX_REPORT_CHARACTERS);
  });

  it('counts one statement for one SELECT 1', async () => {
    const one = await full.meter.measure(() => full.data.query('SELECT 1'));

    expect(one.statements).toBe(1);
    expect(one.sources).toEqual(['SELECT 1']);
  });

  it('reads the step rows and the documents once, grows at most linearly with the runs of the range and reads no body of a run outside it', async () => {
    const small = await metered(50);
    try {
      for (const days of [30, 0]) {
        const big = await full.meter.measure(() => full.controller.report(String(days), '0'));
        const few = await small.meter.measure(() => small.controller.report(String(days), '0'));
        const [bigRuns, fewRuns] = [await runsInRange(full, days), await runsInRange(small, days)];

        for (const measure of [big, few]) {
          expect(statementsReading(measure.sources, 'step_stats')).toHaveLength(1);
          expect(statementsReading(measure.sources, 'documents').length).toBeLessThanOrEqual(1);
        }
        expect(big.characters).toBeLessThanOrEqual(MAX_RUN_CHARACTERS * bigRuns);
        expect(few.characters).toBeLessThanOrEqual(MAX_RUN_CHARACTERS * fewRuns);
      }

      const before = rangeStart(full.db.clock.now(), { days: 30, tzOffset: 0 });
      const outside: { body: string }[] = await full.data.query(
        'SELECT body FROM documents WHERE run_id IN (SELECT id FROM runs WHERE created_at < ? AND updated_at < ?)',
        [before, before],
      );
      const read = await full.meter.measure(() => full.controller.report('30', '0'));

      expect(outside.length).toBeGreaterThan(0);
      expect(read.strings.filter((value) => outside.some(({ body }) => body === value))).toEqual([]);
    } finally {
      await small.db.close();
    }
  }, 60_000);

  it('counts a person message in the range on a run created before it once', async () => {
    const db = await repositoryDatabase();
    try {
      const data = db.app.get(DataSource);
      const day = 24 * 60 * 60 * 1000;
      const created = new Date(db.clock.now() - 40 * day).toISOString();
      const at = new Date(db.clock.now() - day).toISOString();
      const run = await data.getRepository(RunEntity).save({
        key: 'old',
        status: 'running',
        currentStep: 'plan',
        runtime: 'claude',
        codeHost: '',
        createdAt: created,
        updatedAt: created,
      });
      const command = (id: string, type: string): Partial<CommandEntity> => ({
        id,
        runId: run.id,
        type,
        payload: '{}',
        actor: 'ada',
        state: 'done',
        createdAt: at,
        updatedAt: at,
      });
      await data.getRepository(CommandEntity).save([command('chat-1', 'plan-chat'), command('answer-1', 'answer')]);
      const entry = (key: string) => ({ key, role: 'person', author: 'ada', text: 'hi', at, state: 'taken' });
      await data.getRepository(DocumentEntity).save({
        runId: run.id,
        stepStatId: 0,
        kind: 'plan_chat',
        attempt: 1,
        body: JSON.stringify({ entries: [entry('message-chat-1'), entry('message-answer-1')], revisions: [] }),
        path: 'p',
        createdAt: at,
      });
      const controller = new StatsController(db.app.get(StatsRepository), db.app.get(RunRepository), db.clock);

      expect((await controller.report(undefined, '0')).totals.personMessages).toBe(2);
    } finally {
      await db.close();
    }
  });
});
