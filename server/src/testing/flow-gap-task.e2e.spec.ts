import 'reflect-metadata';
import { parseSubtasks, type Subtask } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { CommandService } from '../pipeline/command.service';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { ARTIFACTS, reviewResultOf } from '../steps/contract/artifacts';
import type { ReviewResult } from '../agent-result/definitions/review';
import { createFlowHarness } from './flow-harness';
import { save } from './runs.spec-helpers';

const KEY = 'PROJ-480';

const task = (id: string, covers: string[]): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  covers,
  status: 'waiting',
});

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

const missing = (note: string): ReviewResult => ({
  decision: 'return',
  review: 'Checked.',
  summary: [],
  requirements: [
    { id: 'R1', status: 'met', note: 'done' },
    { id: 'R2', status: 'met', note: 'done' },
    { id: 'R3', status: 'missing', note },
  ],
});

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
  const pass = async () => {
    await flow.app.pipeline.step('implement', KEY);
    await flow.app.app.get(CommandService).idle();
  };

  async function merged(id: string, iid: number): Promise<void> {
    const run = (await runs().findRun(`${KEY}-${id}`))!;
    await documents().putDocument(run, 'requirements', requirements);
    await documents().putDocument(run, 'repos', 'demo\n');
    const record = { project: 'demo', iid, url: `https://code.example/demo/${iid}`, draft: false, summary: '' };
    await documents().putDocument(run, 'merge_request', renderMergeRequest([record]));
    writeRunState(run, { status: 'done', currentStep: 'done' });
    await runs().saveRun(run);
  }

  /** A three-task epic whose tasks merged; the parent went on to its checks. */
  async function epic() {
    const parent = await save(runs(), KEY, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    await runs().saveRun(parent);
    const list = ['R1', 'R2', 'R3'].map((id) => ({ id, text: `Requirement ${id}` }));
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(parent, 'requirement_list', `${JSON.stringify(list)}\n`);
    await documents().putDocument(parent, 'contract', '- api (owner a): the api\n');
    const planned = [task('a', ['R1']), task('b', ['R2']), task('c', ['R3'])];
    await documents().putDocument(parent, 'subtasks', `${JSON.stringify(planned)}\n`);
    await pass();
    for (const [index, id] of ['a', 'b', 'c'].entries()) await merged(id, index + 1);
    await pass();
    await pass();
    expect((await runs().findRun(KEY))?.currentStep).toBe('checks');
    return parent;
  }

  /** Stores what code review stores for a returning final review: its result and the return notes it writes. */
  const review = async (parent: Awaited<ReturnType<typeof epic>>, value: ReviewResult) => {
    await documents().putDocument(
      parent,
      reviewResultOf('requirements').kind,
      reviewResultOf('requirements').format(value),
    );
    await documents().putDocument(parent, ARTIFACTS.return.kind, 'requirements returned the change\n');
  };

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
