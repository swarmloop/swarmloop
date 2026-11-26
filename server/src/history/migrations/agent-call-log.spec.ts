import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { GuardedDataSource } from '../guarded-data-source';
import { historyDatabaseOptions } from '../history.module';
import { AgentCallLog1797300000000 } from './1797300000000-agent-call-log';
import { migrations } from './index';
import { insert, type Row } from './migration-insert.spec-helpers';

const AT = '2026-11-22T10:00:00.000Z';

async function stat(dataSource: DataSource, id: number, run: number, values: Record<string, string | number>) {
  await insert(dataSource, 'step_stats', {
    id,
    run_id: run,
    step: 'implement',
    attempt_id: `attempt-${id}`,
    runtime: 'claude',
    effort: 'high',
    status: 'done',
    ...values,
  });
}

async function exchange(dataSource: DataSource, statId: number, reportedUsd: number) {
  await insert(dataSource, 'agent_exchanges', {
    step_stat_id: statId,
    chat_id: `chat-${statId}`,
    reported_usd: reportedUsd,
    reported_tokens_in: 7,
    reported_tokens_out: 3,
  });
}

async function seedOldDatabase(directory: string): Promise<void> {
  const old = new DataSource({
    ...historyDatabaseOptions(directory),
    migrations: migrations.slice(0, migrations.indexOf(AgentCallLog1797300000000)),
  });
  await old.initialize();
  try {
    await insert(old, 'backlogs', { id: 1, name: 'main' });
    await insert(old, 'runs', { id: 1, key: 'epic-run' });
    await insert(old, 'runs', { id: 2, key: 'part-run', parent_run_id: 1 });
    await insert(old, 'runs', { id: 3, key: 'plain-run' });
    await insert(old, 'backlog_tasks', { backlog_id: 1, slug: 'the-part', run_key: 'part-run' });
    // A visit with two exchanges: its cost lands on the last one.
    await stat(old, 1, 2, { usd: 1.5, tokens_in: 1000, tokens_out: 100 });
    await exchange(old, 1, 0.9);
    await exchange(old, 1, 1.5);
    // A visit that cost something and has no exchange, and one that ran as an epic's parent and hit a limit.
    await stat(old, 2, 3, { usd: 0.25, tokens_in: 50, tokens_out: 5, status: 'failed', kill_reason: 'timeout' });
    await stat(old, 3, 1, {
      usd: 2,
      tokens_in: 10,
      tokens_out: 1,
      status: 'interrupted',
      kill_reason: 'RUNTIME_LIMIT',
    });
    await exchange(old, 3, 2);
    // A visit that cost nothing and has no exchange gets no row.
    await stat(old, 4, 3, { usd: 0, tokens_in: 0, tokens_out: 0 });
    await insert(old, 'backlog_turns', {
      backlog_id: 1,
      turn_key: 'turn-1',
      status: 'applied',
      runtime: 'claude',
      model: 'opus',
      usd: 0.75,
      tokens_in: 400,
      tokens_out: 40,
      created_at: AT,
    });
  } finally {
    await old.destroy();
  }
}

describe('AgentCallLog migration', () => {
  let directory: string;
  let dataSource: DataSource;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'swarmloop-agent-call-log-'));
    await seedOldDatabase(directory);
    dataSource = await new GuardedDataSource(historyDatabaseOptions(directory)).initialize();
  });

  afterEach(async () => {
    await dataSource.destroy();
    rmSync(directory, { recursive: true, force: true });
  });

  const rows = (where: string): Promise<Row[]> =>
    dataSource.query(`SELECT * FROM agent_exchanges WHERE ${where} ORDER BY id`);

  it('adds the columns and the four indexes', async () => {
    const columns = await dataSource.query<{ name: string }[]>(`PRAGMA table_info("agent_exchanges")`);
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['kind', 'run_key', 'own_usd', 'cache_read_tokens', 'end_kind', 'due_at', 'ties']),
    );
    const indexes = await dataSource.query<{ name: string }[]>(`PRAGMA index_list("agent_exchanges")`);
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'IDX_agent_exchanges_run_key',
        'IDX_agent_exchanges_turn_key',
        'IDX_agent_exchanges_attempt_id',
        'IDX_agent_exchanges_ping_due',
      ]),
    );
  });

  it('gives old rows their run key, step, attempt and end', async () => {
    const [first, second] = await rows('step_stat_id = 1');
    expect(first).toMatchObject({ kind: 'call', run_key: 'part-run', step: 'implement', attempt_id: 'attempt-1' });
    expect(second).toMatchObject({ runtime: 'claude', effort: 'high', end_kind: 'done' });
    expect((await rows('step_stat_id = 3'))[0]?.end_kind).toBe('limit');
  });

  it('ties old rows to their backlog, task and epic through the run chain', async () => {
    expect((await rows('step_stat_id = 1'))[0]).toMatchObject({
      backlog: 'main',
      task_slug: 'the-part',
      epic_key: 'epic-run',
    });
    expect((await rows('step_stat_id = 3'))[0]).toMatchObject({ task_slug: null, epic_key: 'epic-run' });
    expect((await rows("run_key = 'plain-run'"))[0]).toMatchObject({ epic_key: null });
  });

  it('puts a visit cost only on its last exchange row', async () => {
    const [first, second] = await rows('step_stat_id = 1');
    expect([first?.own_usd, first?.input_tokens, first?.output_tokens]).toEqual([0, 0, 0]);
    expect([second?.own_usd, second?.input_tokens, second?.output_tokens]).toEqual([1.5, 1000, 100]);
  });

  it('gives a costly visit with no exchange exactly one row, and a free one none', async () => {
    const [row, ...rest] = await rows('step_stat_id = 2');
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ run_key: 'plain-run', step: 'implement', end_kind: 'timed-out', own_usd: 0.25 });
    expect(await rows('step_stat_id = 4')).toEqual([]);
  });

  it('gives a backlog turn one row under its turn key', async () => {
    const [row, ...rest] = await rows(`turn_key = 'turn-1'`);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      step: 'backlog-plan',
      planner_level: 'backlog',
      purpose: 'backlog-turn',
      backlog: 'main',
      model: 'opus',
      end_kind: 'done',
      own_usd: 0.75,
      input_tokens: 400,
      output_tokens: 40,
      step_stat_id: 0,
    });
  });

  it('keeps the old sums on the log and the reported totals as they were', async () => {
    const [runs] = await dataSource.query(
      `SELECT SUM(own_usd) AS usd, SUM(input_tokens + output_tokens) AS tokens FROM agent_exchanges WHERE run_key IS NOT NULL`,
    );
    const [stats] = await dataSource.query(
      `SELECT SUM(usd) AS usd, SUM(tokens_in + tokens_out) AS tokens FROM step_stats`,
    );
    expect(runs).toEqual(stats);
    const [turns] = await dataSource.query(
      `SELECT SUM(own_usd) AS usd FROM agent_exchanges WHERE turn_key IS NOT NULL`,
    );
    expect(turns.usd).toBe(0.75);
    const reported = await dataSource.query(
      `SELECT reported_usd FROM agent_exchanges WHERE reported_tokens_in IS NOT NULL ORDER BY id`,
    );
    expect(reported.map((row: { reported_usd: number }) => row.reported_usd)).toEqual([0.9, 1.5, 2]);
  });
});
