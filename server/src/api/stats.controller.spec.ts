import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { CommandEntity, DocumentEntity, RunEntity } from '../history/entities';
import { DocumentRepository } from '../history/document.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { StatsRepository } from '../history/stats.repository';
import { StatsController } from './stats.controller';
import { meterDatabase } from './sqlite-meter.spec-helpers';
import { seedStatsFixture } from './stats-fixture.spec-helpers';

// Characters of string values SQLite returned to one report call over the 500-run fixture (counted with meterDatabase): 11_992_329 for the whole report, rounded up by about half.
const MAX_REPORT_CHARACTERS = 18_000_000;

async function metered(count?: number) {
  const db = await repositoryDatabase();
  const data = db.app.get(DataSource);
  const meter = meterDatabase(data);
  await seedStatsFixture(data, db.clock.now(), count);
  const controller = new StatsController(
    db.app.get(StatsRepository),
    db.app.get(RunRepository),
    db.app.get(DocumentRepository),
    db.clock,
  );
  return { db, data, meter, controller };
}

type Metered = Awaited<ReturnType<typeof metered>>;

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
  });
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
      const controller = new StatsController(
        db.app.get(StatsRepository),
        db.app.get(RunRepository),
        db.app.get(DocumentRepository),
        db.clock,
      );

      expect((await controller.report(undefined, '0')).totals.personMessages).toBe(2);
    } finally {
      await db.close();
    }
  });
});
