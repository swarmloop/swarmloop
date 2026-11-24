import 'reflect-metadata';
import type { ReviewResult } from '../../agent-result/definitions/review';
import type { Subtask } from '../../contract/subtask';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import type { TestApp } from '../../testing/test-app';
import { InputReader } from '../contract/input-reader';
import { reviewResultOf } from '../contract/artifacts';
import { KEY, seedParent, task, world } from './split-implement.spec-helpers';
import { implementRunner } from './split-or-fix';

/** A settle time later than any document the spec stores: the documents were recorded while the last task still ran. */
const LATER = '2999-01-01T00:00:00.000Z';
const EARLIER = '2000-01-01T00:00:00.000Z';

const RETURN = '## code-review\nrequirements: the field is missing\n';

const missing: ReviewResult = {
  decision: 'return',
  review: 'Checked.',
  summary: [],
  requirements: [{ id: 'R2', status: 'missing', note: 'not written' }],
};

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
    return implementRunner(new InputReader(store), store, { settledAt: () => Promise.resolve(EARLIER) }, run);
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

describe('who runs the implement of a split parent', () => {
  let app: TestApp;
  let parent: RunEntity;
  let documents: DocumentRepository;

  beforeEach(async () => {
    app = (await world()).app;
    parent = await seedParent(
      app,
      [task('a'), task('b')].map((item) => ({ ...item, status: 'merged' as const, covers: ['R2'] })),
    );
    documents = app.app.get(DocumentRepository);
    await documents.putDocument(parent, 'contract', '- api (owner a): the api\n');
  });

  afterEach(async () => {
    await app.close();
  });

  const runner = (settledAt: string) =>
    implementRunner(new InputReader(documents), documents, { settledAt: () => Promise.resolve(settledAt) }, parent);

  const requirementsReview = () =>
    documents.putDocument(parent, reviewResultOf('requirements').kind, reviewResultOf('requirements').format(missing));

  it.each([
    ['quality', 'quality returned the change\n'],
    ['checks', 'checks returned the change\n'],
    ['CI', 'ci returned the change\n'],
  ])('sends a %s return recorded after the last merge to the agent', async (_name, notes) => {
    await documents.putDocument(parent, 'return', notes);
    expect(await runner(EARLIER)).toBe('agent');
  });

  it('sends a requirements return recorded after the last merge to the agent', async () => {
    await requirementsReview();
    await documents.putDocument(parent, 'return', 'requirements returned the change\n');
    expect(await runner(EARLIER)).toBe('agent');
  });

  it('leaves a requirements review recorded while a task still ran to the split pass', async () => {
    await requirementsReview();
    await documents.putDocument(parent, 'return', 'requirements returned the change\n');
    expect(await runner(LATER)).toBe('split');
  });

  it('leaves a return whose gap was taken to the split pass', async () => {
    await requirementsReview();
    await documents.putDocument(parent, 'return', 'requirements returned the change\n');
    const gap = `gap-${(await documents.latestDocument(parent.key, reviewResultOf('requirements').kind))!.id}`;
    const newest = (await documents.latestDocument(parent.key, 'return'))!.id;
    await documents.putDocument(parent, 'starter_taken', JSON.stringify([gap, `${gap}@return-${newest}`, 'gap-1/R2']));
    expect(await runner(LATER)).toBe('split');
  });
});
