import 'reflect-metadata';
import { ERROR_CODES } from '../contract/error-codes';
import { parseSubtasks, type Subtask } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { CommandService } from '../pipeline/command.service';
import { SubtaskPort } from '../pipeline/subtask-port';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { DECIDE_YOURSELF } from '../steps/plan/plan.prompts';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { save } from './runs.spec-helpers';

const KEY = 'PROJ-460';

const task = (id: string, depends: string[] = []): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends,
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

describe('a task that needs a sibling waits for it', () => {
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
  const child = async (id: string) => (await runs().findRun(`${KEY}-${id}`))!;
  const tasks = async () => parseSubtasks(await documents().latestBody(KEY, 'subtasks'));
  const statuses = async () => Object.fromEntries((await tasks()).map((item) => [item.id, item.status]));

  /** The starts of one subtask run after the epic's first pass. Other runs the parent touches, such as a rebase of a merged sibling, are not what these specs are about. */
  let started = 0;
  const relaunched = (id: string) => flow.launched.slice(started).filter((key) => key === `${KEY}-${id}`);

  async function pass(): Promise<void> {
    await flow.app.pipeline.step('implement', KEY);
    await flow.app.app.get(CommandService).idle();
    await assertInvariants(flow.app);
  }

  async function seedEpic(list: Subtask[]): Promise<void> {
    const parent = await save(runs(), KEY, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    await runs().saveRun(parent);
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(parent, 'subtasks', `${JSON.stringify(list)}\n`);
    await pass();
    started = flow.launched.length;
  }

  /** The step of the subtask ended with `needs:`, as the step leaves it: waiting at that step, nothing committed. */
  async function needs(id: string, step: string, lines: string): Promise<void> {
    const run = await child(id);
    await documents().putDocument(run, 'repos', 'demo\n');
    await documents().putDocument(run, 'needs', `needs:\n${lines}\n`);
    writeRunState(run, {
      status: 'waiting',
      currentStep: step,
      reason: { code: ERROR_CODES.SUBTASK_WAITING, message: 'waiting' },
    });
    await runs().saveRun(run);
  }

  async function done(id: string, iid: number, summary = ''): Promise<void> {
    const run = await child(id);
    await documents().putDocument(run, 'requirements', requirements);
    await documents().putDocument(run, 'repos', 'demo\n');
    const record = { project: 'demo', iid, url: `https://code.example/demo/${iid}`, draft: false, summary };
    await documents().putDocument(run, 'merge_request', renderMergeRequest([record]));
    writeRunState(run, { status: 'done', currentStep: 'done' });
    await runs().saveRun(run);
  }

  it.each(['research', 'plan', 'implement'])(
    'waits at %s, gets the edge and a decision, and runs the step again once the sibling merged',
    async (step) => {
      await seedEpic([task('a'), task('b')]);
      await needs('a', step, '- b: the retry policy');

      await pass();

      expect((await tasks()).find((item) => item.id === 'a')?.depends).toEqual(['b']);
      expect(await documents().latestBody(KEY, 'contract')).toContain('- a depends on b: the retry policy');
      expect(relaunched('a')).toEqual([]);
      expect(await documents().latestBody(`${KEY}-a`, 'needs')).toContain('b: the retry policy');

      await done('b', 1, 'adds the retry policy');
      await pass();
      expect((await statuses()).b).toBe('merged');
      await pass();

      expect(relaunched('a')).toEqual([`${KEY}-a`]);
      expect(await documents().latestBody(`${KEY}-a`, 'needs')).toBe('');
      expect(await documents().latestBody(`${KEY}-a`, 'handoff')).toContain(
        `## ${step}\nb merged: adds the retry policy`,
      );

      await done('a', 2);
      await flow.app.pipeline.step('implement', KEY);
      expect(await statuses()).toEqual({ a: 'merged', b: 'merged' });
      expect((await runs().findRun(KEY))?.currentStep).toBe('checks');
    },
  );

  it('does not add the edge twice when the pass repeats', async () => {
    await seedEpic([task('a'), task('b')]);
    await needs('a', 'implement', '- b: the retry policy');

    await pass();
    await pass();

    const contract = (await documents().latestBody(KEY, 'contract')) ?? '';
    expect(contract.match(/a depends on b/g)).toHaveLength(1);
    expect((await tasks()).find((item) => item.id === 'a')?.depends).toEqual(['b']);
  });

  it.each([
    ['itself', [task('a'), task('b')], '- a: its own result'],
    ['an unknown task', [task('a'), task('b')], '- zzz: something'],
    ['a task that depends on it', [task('a'), task('b', ['a'])], '- b: its result'],
  ])('puts a need that names %s to the planner and adds no edge', async (_name, list, line) => {
    await seedEpic(list);
    jest.spyOn(flow.app.app.get(SubtaskPort), 'askAbout').mockResolvedValue('Build it in this task.');
    await needs('a', 'implement', line);

    await pass();

    expect((await tasks()).find((item) => item.id === 'a')?.depends).toEqual([]);
    expect(await documents().latestBody(KEY, 'contract')).toContain('- subtask a: Build it in this task.');
    expect(relaunched('a')).toEqual([`${KEY}-a`]);
    expect(await documents().latestBody(`${KEY}-a`, 'handoff')).toContain('Build it in this task.');
    expect(await documents().latestBody(`${KEY}-a`, 'needs')).toBe('');
  });

  it('tells the task to decide itself when the planner gives no answer', async () => {
    await seedEpic([task('a'), task('b')]);
    jest.spyOn(flow.app.app.get(SubtaskPort), 'askAbout').mockResolvedValue(null);
    await needs('a', 'research', '- zzz: something');

    await pass();

    expect(await documents().latestBody(`${KEY}-a`, 'handoff')).toContain(DECIDE_YOURSELF);
  });

  it('lets a task that waits for a sibling free its slot, so the sibling can start', async () => {
    await flow.close();
    flow = await createFlowHarness(KEY, { env: { SUBTASKS_PARALLEL: '1' } });
    await seedEpic([task('a'), task('b')]);
    expect(await statuses()).toEqual({ a: 'running', b: 'waiting' });
    await needs('a', 'implement', '- b: the retry policy');

    await pass();

    expect((await statuses()).b).toBe('running');
  });
});
