import 'reflect-metadata';
import type { ReviewResult } from '../../agent-result/definitions/review';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import type { TestApp } from '../../testing/test-app';
import { InputReader } from '../contract/input-reader';
import { reviewResultOf } from '../contract/artifacts';
import { implementRunner } from './split-or-fix';
import { seedParent, task, world } from './split-implement.spec-helpers';

/** A settle time later than any document the spec stores: the documents were recorded while the last task still ran. */
const LATER = '2999-01-01T00:00:00.000Z';
const EARLIER = '2000-01-01T00:00:00.000Z';

const missing: ReviewResult = {
  decision: 'return',
  review: 'Checked.',
  summary: [],
  requirements: [{ id: 'R2', status: 'missing', note: 'not written' }],
};

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
