import 'reflect-metadata';
import { parseSubtasks } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { createFlowHarness } from './flow-harness';
import { gapEpic, missing } from './gap-epic.spec-helpers';

const KEY = 'PROJ-480';

describe('a final review gap becomes a task', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);
  const tasks = async () => parseSubtasks(await documents().latestBody(KEY, 'subtasks'));
  /** How many times the split pass finished the parent's implement: it writes the implementation record each time. */
  const finishes = async () =>
    (await documents().listDocuments((await runs().findRun(KEY))!.id)).filter((item) => item.kind === 'implementation')
      .length;
  const { pass, merged, epic, review } = gapEpic(() => flow, KEY);

  it('plans, reviews and merges a task for the undelivered requirement, and the epic ends done', async () => {
    const parent = await epic();
    await review(parent, missing('nothing writes it'));

    await pass();
    const added = (await tasks()).find((item) => item.id === 'gap-1');
    expect(added).toMatchObject({ covers: ['R3'], status: 'running' });
    expect(await runs().findRun(`${KEY}-gap-1`)).not.toBeNull();

    await merged('gap-1', 4);
    await pass();
    await pass();

    expect((await tasks()).every((item) => item.status === 'merged')).toBe(true);
    expect((await runs().findRun(KEY))?.currentStep).toBe('checks');
    expect(await finishes()).toBe(2);
    expect(await documents().latestBody(KEY, 'subtask_questions')).toBeFalsy();
  });

  it('asks whoever started the run when the requirement is still missing after its gap task merged', async () => {
    const parent = await epic();
    await review(parent, missing('nothing writes it'));
    await pass();
    await merged('gap-1', 4);
    await pass();
    await pass();

    await review(parent, missing('still not written'));
    await pass();

    expect((await tasks()).map((item) => item.id)).toEqual(['a', 'b', 'c', 'gap-1']);
    const asked = (await documents().latestBody(KEY, 'subtask_questions')) ?? '';
    expect(asked).toContain('R3 is still missing after gap task gap-1 merged');
    expect((await runs().findRun(KEY))?.status).toBe('waiting');

    const question = asked.trim().replace(/^- /, '');
    await documents().putDocument(parent, 'answers', `question: ${question}\nanswer: Out of scope.\n`);
    await pass();
    expect((await tasks()).map((item) => item.id)).toEqual(['a', 'b', 'c', 'gap-1']);
    expect((await runs().findRun(KEY))?.currentStep).toBe('checks');
  });
});
