import 'reflect-metadata';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { sentence } from '../../api/run-view/flow-waiting';
import { boot, save } from '../../testing/runs.spec-helpers';
import { DocumentRepository } from '../document.repository';
import { RunRepository } from '../run.repository';
import { storedState } from '../run-state';
import { BlockedCodes1797100000000 } from './1797100000000-blocked-codes';

type App = Awaited<ReturnType<typeof boot>>;

// One app serves every case: each case seeds a row of its own and reads only that row after the migration.
let root: string;
let app: App;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'swarmloop-blocked-codes-'));
  app = await boot(root);
});

afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

const STOP_NOTE = 'Stopped by request. Commits, pushes and merge requests stay: Stop is not a rollback.';
const reasonOf = (code: string, message = 'was stored') => JSON.stringify({ code, message });

interface Seed {
  step: string;
  /** The raw state_reason: a code, JSON text or none. */
  stored?: string | null;
  errors?: string[];
  status?: string;
  state?: string;
}

let counter = 0;

/** Saves the row, then sets the two columns by SQL, which sends no notice. */
async function seed(item: Seed): Promise<number> {
  const run = await save(app.get(RunRepository), `proj-${(counter += 1)}`, item.step, item.status ?? 'blocked');
  for (const body of item.errors ?? []) await app.get(DocumentRepository).putDocument(run, 'error', body);
  const stored = item.stored === undefined || item.stored === null ? null : item.stored;
  await app
    .get(DataSource)
    .query(`UPDATE runs SET state_reason = ?, state = ? WHERE id = ?`, [
      stored,
      item.state ?? (item.status && item.status !== 'blocked' ? item.status : 'blocked'),
      run.id,
    ]);
  return run.id;
}

async function migrate(): Promise<void> {
  const runner = app.get(DataSource).createQueryRunner();
  try {
    await new BlockedCodes1797100000000().up(runner);
  } finally {
    await runner.release();
  }
}

async function readRow(key: string) {
  const run = await app.get(RunRepository).findRun(key);
  const { state, reason } = storedState(run!);
  return { state, code: reason?.code, message: reason?.message };
}

/** Seeds one row, migrates and reads it back as the readers do. */
async function after(item: Seed): Promise<{ state: string; code?: string; message?: string }> {
  const key = `proj-${counter + 1}`;
  await seed(item);
  await migrate();
  return readRow(key);
}

const codeAfter = async (item: Seed) => (await after(item)).code;

describe('BlockedCodes migration', () => {
  it('gives a blocked run without a code the code its last error names', async () => {
    expect(await after({ step: 'implement', errors: ['implement does not fit'] })).toEqual({
      state: 'blocked',
      code: 'DID_NOT_FIT',
      message: 'blocked',
    });
  });

  it('gives a stored BLOCKED the code its last error names and keeps the stored message', async () => {
    expect(
      await after({
        step: 'implement',
        stored: reasonOf('BLOCKED'),
        errors: ['repo: npm test failed again on unchanged files after a relaunch'],
      }),
    ).toEqual({ state: 'blocked', code: 'CHECK_FAILED', message: 'was stored' });
  });

  it('reads the error document with the highest id', async () => {
    expect(await codeAfter({ step: 'plan', errors: ['plan does not fit', 'CI_TIMEOUT: lint timed out'] })).toBe(
      'CI_TIMEOUT',
    );
  });

  it('keeps a kept code over the text of the error', async () => {
    expect(await codeAfter({ step: 'plan', stored: reasonOf('SPEND_LIMIT'), errors: ['plan does not fit'] })).toBe(
      'SPEND_LIMIT',
    );
  });

  it('keeps a stored git rule when the error names no reason', async () => {
    expect(await codeAfter({ step: 'plan', stored: reasonOf('GIT_RULES'), errors: ['push refused'] })).toBe(
      'GIT_RULES',
    );
  });

  it('reads a stop note as a stopped run', async () => {
    expect(await after({ step: 'implement', errors: [STOP_NOTE] })).toMatchObject({
      state: 'stopped',
      code: 'STOPPED',
    });
  });

  it('keeps the stored code of a loop step when it is not BLOCKED, and fills in the loop limit otherwise', async () => {
    expect(await codeAfter({ step: 'checks', stored: reasonOf('GIT_RULES') })).toBe('GIT_RULES');
    expect(await codeAfter({ step: 'checks', stored: reasonOf('BLOCKED') })).toBe('LOOP_LIMIT');
    expect(await codeAfter({ step: 'code-review' })).toBe('LOOP_LIMIT');
  });

  it('gives a block outside the loop steps with no reason the plain BLOCKED, also over a stored text that is not JSON', async () => {
    expect(await after({ step: 'prepare', stored: 'not json' })).toEqual({
      state: 'blocked',
      code: 'BLOCKED',
      message: 'blocked',
    });
  });

  it('leaves a skipped row and rows that are not blocked as they are', async () => {
    expect(await codeAfter({ step: 'checks', stored: reasonOf('SKIPPED'), state: 'skipped' })).toBe('SKIPPED');
    expect(
      await after({ step: 'checks', status: 'waiting', state: 'waiting', stored: null, errors: ['plan does not fit'] }),
    ).toMatchObject({ state: 'waiting', code: undefined });
  });

  it('tells a repeated check, a budget that does not fit, a loop step and any other block apart', async () => {
    const flaky = 'TEST_FLAKY: a test failed and passed on the same code twice; fix the race, not the test';
    const cases: [Seed, string][] = [
      [
        { step: 'implement-improve', errors: ['repo: npm test failed again on unchanged files after a relaunch'] },
        'CHECK_FAILED',
      ],
      [{ step: 'code-review', errors: ['code-review does not fit'] }, 'DID_NOT_FIT'],
      [{ step: 'pipeline' }, 'LOOP_LIMIT'],
      [{ step: 'prepare', errors: ['x'] }, 'BLOCKED'],
      [{ step: 'pipeline', errors: ['CI_LOG_UNAVAILABLE: a failed job has no readable log'] }, 'CI_LOG_UNAVAILABLE'],
      [{ step: 'pipeline', errors: ['CI_NOT_RUN: CI did not run lint'] }, 'CI_NOT_RUN'],
      [{ step: 'pipeline', errors: ['CI_TIMEOUT: lint timed out'] }, 'CI_TIMEOUT'],
      [{ step: 'pipeline', errors: [flaky] }, 'TEST_FLAKY'],
      [{ step: 'prepare', errors: [flaky] }, 'TEST_FLAKY'],
    ];
    for (const [item, code] of cases) expect(await codeAfter(item)).toBe(code);
  });

  it('gives a block its code', async () => {
    expect(await codeAfter({ step: 'implement', stored: reasonOf('BLOCKED'), errors: ['x'] })).toBe('BLOCKED');
    expect(
      await codeAfter({ step: 'implement', errors: ['repo: a failed again on unchanged files after a relaunch'] }),
    ).toBe('CHECK_FAILED');
  });

  it('gives the code read from the error text over a stored code that is not on the kept list', async () => {
    expect(await codeAfter({ step: 'plan', stored: reasonOf('GIT_RULES'), errors: ['plan does not fit'] })).toBe(
      'DID_NOT_FIT',
    );
  });

  it('gives a blocked row with no code the code of its error', async () => {
    expect(await codeAfter({ step: 'plan', errors: ['The plan does not fit the limit.'] })).toBe('DID_NOT_FIT');
  });

  it.each([
    ['DID_NOT_FIT', 'plan does not fit'],
    ['CHECK_FAILED', 'a failed again on unchanged files after a relaunch'],
  ])('gives %s from the error text over a stored BLOCKED', async (code, error) => {
    expect(await codeAfter({ step: 'plan', stored: reasonOf('BLOCKED'), errors: [error] })).toBe(code);
  });

  it('gives the code of the error text over a stored REBASE_CONFLICT', async () => {
    expect(await codeAfter({ step: 'plan', stored: reasonOf('REBASE_CONFLICT'), errors: ['plan does not fit'] })).toBe(
      'DID_NOT_FIT',
    );
  });

  it('fills in the loop limit of a step over a stored BLOCKED', async () => {
    expect(await codeAfter({ step: 'pipeline', stored: reasonOf('BLOCKED') })).toBe('LOOP_LIMIT');
  });

  it('gives a blocked run with no stored code the code of its error', async () => {
    expect(await after({ step: 'prepare', errors: ['code-review does not fit\n'] })).toMatchObject({
      state: 'blocked',
      code: 'DID_NOT_FIT',
    });
  });

  it('gives a blocked run with no code the code of its error', async () => {
    expect(await after({ step: 'plan', errors: ['The plan does not fit the limit.'] })).toEqual({
      state: 'blocked',
      code: 'DID_NOT_FIT',
      message: 'blocked',
    });
  });

  it('keeps an old blocked STOPPED row at a non-loop step as stopped, with the plain sentence, when an older error says it does not fit', async () => {
    const key = `proj-${counter + 1}`;
    await seed({
      step: 'implement',
      stored: reasonOf('STOPPED'),
      state: 'stopped',
      errors: ['implement does not fit'],
    });
    await migrate();
    expect(await readRow(key)).toMatchObject({ state: 'stopped', code: 'STOPPED' });
    const run = (await app.get(RunRepository).findRun(key))!;
    const documents = await app.get(DocumentRepository).listDocuments(run.id);
    const said = sentence(run, [], documents, [], 3);
    expect(said).toBe('This run is blocked. Another return is not available.');
    expect(said).not.toContain('agent-call budget');
  });
});
