import type { FlakyTestDraft } from './flaky-test.repository';
import { FlakyTestRepository } from './flaky-test.repository';
import { repositoryDatabase } from './repository.spec-helpers';

const MAIN = 'refs/heads/main';

function draft(runId: string, overrides: Partial<FlakyTestDraft> = {}): FlakyTestDraft {
  return {
    runId,
    project: 'repo',
    test: 'a step relaunched once',
    ref: `refs/heads/feature/${runId}`,
    seed: '20260101',
    failedLog: 'failed log',
    passedLog: 'passed log',
    createdAt: '2026-11-12T10:00:00Z',
    ...overrides,
  };
}

async function withFlaky(body: (flaky: FlakyTestRepository) => Promise<void>): Promise<void> {
  const db = await repositoryDatabase();
  try {
    await body(db.app.get(FlakyTestRepository));
  } finally {
    await db.close();
  }
}

describe('FlakyTestRepository', () => {
  it('does not block on one record on one run', () =>
    withFlaky(async (flaky) => {
      await flaky.record(draft('run-a'));
      expect(await flaky.blocks('repo', 'a step relaunched once', MAIN)).toBe(false);
    }));

  it('does not block on one record on another run', () =>
    withFlaky(async (flaky) => {
      await flaky.record(draft('run-a'));
      expect(await flaky.blocks('repo', 'a step relaunched once', MAIN)).toBe(false);
    }));

  it('blocks on records on two runs', () =>
    withFlaky(async (flaky) => {
      await flaky.record(draft('run-a'));
      await flaky.record(draft('run-b'));
      expect(await flaky.blocks('repo', 'a step relaunched once', MAIN)).toBe(true);
    }));

  it('blocks on a record on the main ref', () =>
    withFlaky(async (flaky) => {
      await flaky.record(draft('run-a', { ref: MAIN }));
      expect(await flaky.blocks('repo', 'a step relaunched once', MAIN)).toBe(true);
    }));

  it('does not count a record of another test or project', () =>
    withFlaky(async (flaky) => {
      await flaky.record(draft('run-a', { test: 'other test' }));
      await flaky.record(draft('run-b', { project: 'other', ref: MAIN }));
      expect(await flaky.blocks('repo', 'a step relaunched once', MAIN)).toBe(false);
    }));

  it('keeps blocking after later records', () =>
    withFlaky(async (flaky) => {
      await flaky.record(draft('run-a'));
      await flaky.record(draft('run-b'));
      await flaky.record(draft('run-c', { test: 'other test' }));
      await flaky.record(draft('run-a'));
      expect(await flaky.blocks('repo', 'a step relaunched once', MAIN)).toBe(true);
    }));
});
