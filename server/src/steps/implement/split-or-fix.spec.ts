import 'reflect-metadata';
import type { Subtask } from '../../contract/subtask';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import type { TestApp } from '../../testing/test-app';
import { InputReader } from '../contract/input-reader';
import { KEY, seedParent, task, world } from './split-implement.spec-helpers';
import { implementRunner } from './split-or-fix';

const RETURN = '## code-review\nrequirements: the field is missing\n';

describe('implementRunner', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  /** A split parent with the given tasks and documents; the runner's answer for it. */
  async function runner(statuses: Subtask['status'][], documents: Record<string, string> = {}) {
    app = (await world()).app;
    const parent = await seedParent(
      app,
      statuses.map((status, index) => ({ ...task(`t${index}`), status })),
    );
    const store = app.app.get(DocumentRepository);
    for (const [kind, body] of Object.entries(documents)) await store.putDocument(parent, kind, body);
    const run = await app.app.get(RunRepository).findRun(KEY);
    return implementRunner(new InputReader(store), store, run);
  }

  it('gives a parked conflict of the run own branch to the agent while tasks are open', async () => {
    expect(await runner(['merged', 'waiting'], { rebase_conflict: 'pending-implement\n' })).toBe('agent');
  });

  it('gives the own-edits marker to the agent while tasks are open', async () => {
    expect(await runner(['merged', 'running'], { rebase_conflict: 'pending\nown edits conflict\n' })).toBe('agent');
  });

  it('gives a return from an open round to the agent while tasks are open', async () => {
    expect(await runner(['merged', 'waiting'], { epic_round: 'open\n', return: RETURN })).toBe('agent');
  });

  it('keeps the split pass for the marker review, or none, with no return from the round', async () => {
    expect(await runner(['merged', 'waiting'], { rebase_conflict: 'review\n' })).toBe('split');
    await app.close();
    expect(await runner(['merged', 'waiting'])).toBe('split');
  });

  it('keeps the split pass for an open round with no return', async () => {
    expect(await runner(['merged', 'waiting'], { epic_round: 'open\n' })).toBe('split');
  });

  it('keeps the split pass once a passed round left no return and no issues', async () => {
    expect(await runner(['merged', 'waiting'], { epic_round: '', return: '', issues: '[]\n' })).toBe('split');
  });

  it('gives a return to the agent only once every task is settled, outside a round', async () => {
    expect(await runner(['merged', 'waiting'], { return: RETURN })).toBe('split');
    await app.close();
    expect(await runner(['merged', 'merged'], { return: RETURN })).toBe('agent');
  });

  it('gives a conflict of a settled epic to the agent', async () => {
    expect(await runner(['merged', 'skipped'], { rebase_conflict: 'pending\n' })).toBe('agent');
  });
});
