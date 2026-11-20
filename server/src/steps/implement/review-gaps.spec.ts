import 'reflect-metadata';
import type { ReviewResult } from '../../agent-result/definitions/review';
import { DocumentRepository } from '../../history/document.repository';
import type { TestApp } from '../../testing/test-app';
import { reviewResultOf } from '../contract/artifacts';
import { parseSubtasks } from '../../contract/subtask';
import { gapOf, gapTaken } from './review-gaps';
import { KEY, pass, seedParent, task, tasksOf, world } from './split-implement.spec-helpers';

const KIND = reviewResultOf('requirements').kind;

const review = (marks: Record<string, 'met' | 'partial' | 'missing'>, decision: 'ok' | 'return'): ReviewResult => ({
  decision,
  review: 'Checked.',
  summary: [],
  requirements: Object.entries(marks).map(([id, status]) => ({ id, status, note: `note for ${id}` })),
});

describe('final review gaps', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  /** A parent whose tasks are merged and that holds the contract and the requirements list. */
  async function merged(tasks = [task('a'), task('b')]) {
    app = (await world()).app;
    const parent = await seedParent(
      app,
      tasks.map((item) => ({ ...item, status: 'merged', covers: item.id === 'a' ? ['R1'] : ['R2'] })),
    );
    const documents = app.app.get(DocumentRepository);
    await documents.putDocument(parent, 'contract', '- api (owner a): the api\n- name (owner b): the name\n');
    await documents.putDocument(
      parent,
      'requirement_list',
      `${JSON.stringify([
        { id: 'R1', text: 'one' },
        { id: 'R2', text: 'two' },
      ])}\n`,
    );
    return { parent, documents };
  }

  const reviewed = async (
    documents: DocumentRepository,
    parent: Awaited<ReturnType<typeof merged>>['parent'],
    value: ReviewResult,
  ) => documents.putDocument(parent, KIND, reviewResultOf('requirements').format(value));

  it('adds one task that covers the requirements a final review marks partial or missing, after the others', async () => {
    const { parent, documents } = await merged();
    await reviewed(documents, parent, review({ R1: 'met', R2: 'missing', api: 'partial' }, 'return'));

    await pass(app);

    const tasks = await tasksOf(app);
    expect(tasks.map((item) => item.id)).toEqual(['a', 'b', 'gap-1']);
    expect(tasks[2]).toMatchObject({ covers: ['R2'], status: 'running' });
    expect(tasks[2].description).toContain('Gap for: R2, api');
  });

  it('does not take the same review twice, and a new review of the same id is a new gap', async () => {
    const { parent, documents } = await merged();
    await reviewed(documents, parent, review({ R1: 'met', R2: 'missing' }, 'return'));
    await pass(app);
    await pass(app);
    expect((await tasksOf(app)).map((item) => item.id)).toEqual(['a', 'b', 'gap-1']);

    const taken = JSON.parse((await documents.latestBody(KEY, 'starter_taken')) ?? '[]') as string[];
    expect(await gapOf(documents, KEY, taken)).toBeNull();
    await reviewed(documents, parent, review({ R1: 'met', R2: 'partial' }, 'return'));
    expect(await gapOf(documents, KEY, taken)).toMatchObject({ marks: [{ id: 'R2', status: 'partial' }] });
  });

  it('counts a return as the taken gap only until a failed check returns the run again', async () => {
    const { parent, documents } = await merged();
    await reviewed(documents, parent, review({ R1: 'met', R2: 'missing' }, 'return'));
    await documents.putDocument(parent, 'return', 'requirements returned the change\n');
    await pass(app);
    const taken = JSON.parse((await documents.latestBody(KEY, 'starter_taken')) ?? '[]') as string[];
    expect(await gapTaken(documents, parent, taken)).toBe(true);

    await documents.putDocument(parent, 'issues', '[]');
    expect(await gapTaken(documents, parent, taken)).toBe(false);
  });

  it('gives no gap for a return that marks nothing, or for a review that passes', async () => {
    const { parent, documents } = await merged();
    await reviewed(documents, parent, review({ R1: 'met', R2: 'met' }, 'return'));
    expect(await gapOf(documents, KEY, [])).toBeNull();
    await reviewed(documents, parent, review({ R1: 'met', R2: 'met' }, 'ok'));
    expect(await gapOf(documents, KEY, [])).toBeNull();
  });

  it('asks whoever started the run when a requirement is still missing after its gap task merged, and adds no second task', async () => {
    const gap = {
      ...task('gap-1'),
      status: 'merged' as const,
      description: 'Closes it.\nGap for: R2',
      covers: ['R2'],
    };
    const { parent, documents } = await merged([task('a'), task('b'), gap]);
    await documents.putDocument(parent, 'starter_taken', JSON.stringify(['gap-1/R2']));
    await reviewed(documents, parent, review({ R1: 'met', R2: 'missing' }, 'return'));

    await pass(app);

    expect((await tasksOf(app)).map((item) => item.id)).toEqual(['a', 'b', 'gap-1']);
    const asked = (await documents.latestBody(KEY, 'subtask_questions')) ?? '';
    expect(asked).toContain('R2 is still missing after gap task gap-1 merged');
    expect(parseSubtasks(await documents.latestBody(KEY, 'subtasks')).every((item) => item.status === 'merged')).toBe(
      true,
    );
  });

  it('asks instead of dropping the gap when the added task is refused', async () => {
    const { parent, documents } = await merged();
    await documents.putDocument(parent, 'contract', '');
    await reviewed(documents, parent, review({ R1: 'met', R2: 'missing' }, 'return'));

    await pass(app);

    expect((await tasksOf(app)).map((item) => item.id)).toEqual(['a', 'b']);
    expect((await documents.latestBody(KEY, 'subtask_questions')) ?? '').toContain('its gap task was refused');
  });
});
