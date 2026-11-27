import 'reflect-metadata';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { boot, save } from '../../testing/runs.spec-helpers';
import { RunRepository } from '../run.repository';
import { storedState } from '../run-state';
import { RunStateFilled1797700000000 } from './1797700000000-run-state-filled';

type App = Awaited<ReturnType<typeof boot>>;

// One app serves every case: each case seeds a row of its own and reads only that row after the migration.
let root: string;
let app: App;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'swarmloop-run-state-filled-'));
  app = await boot(root);
});

afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

const reasonOf = (code: string, message = 'was stored') => JSON.stringify({ code, message });

interface Seed {
  status: string;
  step?: string;
  /** The raw state_reason: JSON text or none. */
  stored?: string | null;
  /** The raw state column; none leaves it empty. */
  state?: string | null;
  mergeOutcome?: string | null;
  attemptsChecks?: number;
}

let counter = 0;

/** Saves the row, then sets its columns by SQL, which sends no notice. */
async function seed(item: Seed): Promise<string> {
  const key = `proj-${(counter += 1)}`;
  const run = await save(app.get(RunRepository), key, item.step ?? 'research', item.status);
  await app
    .get(DataSource)
    .query(`UPDATE runs SET state = ?, state_reason = ?, merge_outcome = ?, attempts_checks = ? WHERE id = ?`, [
      item.state ?? null,
      item.stored ?? null,
      item.mergeOutcome ?? null,
      item.attemptsChecks ?? 0,
      run.id,
    ]);
  return key;
}

async function after(item: Seed): Promise<{ state: string; code?: string; message?: string }> {
  const key = await seed(item);
  const runner = app.get(DataSource).createQueryRunner();
  try {
    await new RunStateFilled1797700000000().up(runner);
  } finally {
    await runner.release();
  }
  const { state, reason } = storedState((await app.get(RunRepository).findRun(key))!);
  return { state, code: reason?.code, message: reason?.message };
}

describe('RunStateFilled1797700000000', () => {
  it('gives a running row with no state the state running', async () => {
    expect(await after({ status: 'running' })).toMatchObject({ state: 'running', code: undefined });
  });

  it('gives a waiting row with no state and no attempts the state idle with no reason', async () => {
    expect(await after({ status: 'waiting' })).toMatchObject({ state: 'idle', code: undefined });
  });

  it('marks a waiting row at implement with an earlier attempt as returned', async () => {
    expect(await after({ status: 'waiting', step: 'implement', attemptsChecks: 1 })).toMatchObject({
      state: 'idle',
      code: 'RETURNED',
    });
  });

  it('keeps the waiting reason a waiting row stored', async () => {
    expect(await after({ status: 'waiting', stored: reasonOf('RUNTIME_LIMIT') })).toMatchObject({
      state: 'waiting',
      code: 'RUNTIME_LIMIT',
    });
  });

  it('reads a blocked row by its stored code, and a stopped one as stopped', async () => {
    expect(await after({ status: 'blocked', stored: reasonOf('LOOP_LIMIT') })).toMatchObject({
      state: 'blocked',
      code: 'LOOP_LIMIT',
    });
    expect(await after({ status: 'blocked', stored: reasonOf('STOPPED') })).toMatchObject({ state: 'stopped' });
    expect(await after({ status: 'blocked' })).toMatchObject({ state: 'blocked', code: 'BLOCKED', message: 'blocked' });
  });

  it('reads a failed row as failed, and a stopped one as stopped', async () => {
    expect(await after({ status: 'failed', stored: reasonOf('X') })).toMatchObject({ state: 'failed', code: 'X' });
    expect(await after({ status: 'failed', stored: reasonOf('STOPPED') })).toMatchObject({ state: 'stopped' });
  });

  it('reads a done row by its merge outcome', async () => {
    const merged = JSON.stringify({ merged: {} });
    const closed = JSON.stringify({ closed: { repo: 'r', by: null, at: 't' } });
    expect(await after({ status: 'done', mergeOutcome: merged })).toMatchObject({ state: 'merged' });
    expect(await after({ status: 'done', mergeOutcome: closed })).toMatchObject({ state: 'closed' });
    expect(await after({ status: 'done' })).toMatchObject({ state: 'done' });
  });

  it('reads a skipped row as skipped', async () => {
    expect(await after({ status: 'waiting', stored: reasonOf('SKIPPED') })).toMatchObject({
      state: 'skipped',
      code: 'SKIPPED',
    });
  });

  it('keeps the state and reason of a row that has a state', async () => {
    const stored = reasonOf('NEEDS_ANSWERS', 'waiting for a person');
    expect(await after({ status: 'waiting', state: 'waiting', stored })).toEqual({
      state: 'waiting',
      code: 'NEEDS_ANSWERS',
      message: 'waiting for a person',
    });
  });
});
