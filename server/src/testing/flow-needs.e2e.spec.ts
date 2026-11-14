import { handoffText } from '../steps/shared/handoff';
import 'reflect-metadata';
import { ERROR_CODES } from '../contract/error-codes';
import { parseSubtasks, type Subtask } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { StepStatEntity } from '../history/entities';
import { VisitRepository } from '../history/visit.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { RunQueriesService } from '../api/run-queries.service';
import { CommandService } from '../pipeline/command.service';
import { SubtaskPort } from '../pipeline/subtask-port';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
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

  /** The invariants do not know a run that waits for a person at implement: they read its state without the open questions. */
  async function pass(invariants = true): Promise<void> {
    await flow.app.pipeline.step('implement', KEY);
    await flow.app.app.get(CommandService).idle();
    if (invariants) await assertInvariants(flow.app);
  }

  /** The rerun of a task ran its step, as it does with a model: its next rerun is a new event. */
  async function ran(id: string): Promise<void> {
    const run = await child(id);
    const now = new Date().toISOString();
    await flow.app.app.get(VisitRepository).saveStat(
      Object.assign(new StepStatEntity(), {
        runId: run.id,
        step: run.currentStep,
        attempt: 1,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        status: 'ok',
      }),
    );
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
      expect(handoffText(await documents().latestBody(`${KEY}-a`, 'handoff'))).toContain(
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
    expect(handoffText(await documents().latestBody(`${KEY}-a`, 'handoff'))).toContain('Build it in this task.');
    expect(await documents().latestBody(`${KEY}-a`, 'needs')).toBe('');
  });

  const NOT_BUILT =
    'Do the part your task needs inside your task, or keep the current shape and write it as not built.';
  const NOBODY = 'No one can answer these questions';
  const view = () => flow.app.app.get(RunQueriesService).flow(KEY);
  const handoff = async () => handoffText(await documents().latestBody(`${KEY}-a`, 'handoff'));

  it('tells the task why its need was refused when the planner gives no answer', async () => {
    await seedEpic([task('a'), task('b')]);
    jest.spyOn(flow.app.app.get(SubtaskPort), 'askAbout').mockResolvedValue(null);
    await needs('a', 'research', '- zzz: something');

    await pass();

    expect(await handoff()).toContain('zzz cannot go first: no task has the id zzz');
    expect(await handoff()).not.toContain(NOBODY);
  });

  it('reruns a task that needs a sibling that depends on it once, with the reason in its handoff', async () => {
    await seedEpic([task('a'), task('b', ['a'])]);
    jest.spyOn(flow.app.app.get(SubtaskPort), 'askAbout').mockResolvedValue(null);
    await needs('a', 'implement', '- b: its result');

    await pass();

    expect(relaunched('a')).toHaveLength(1);
    expect(await handoff()).toContain(
      `b cannot go first: b depends on a, so waiting for it would never end. ${NOT_BUILT}`,
    );
    expect(await handoff()).not.toContain(NOBODY);
  });

  it('puts the same refused need to the person, and the answer reaches the task', async () => {
    await seedEpic([task('a'), task('b', ['a'])]);
    jest.spyOn(flow.app.app.get(SubtaskPort), 'askAbout').mockResolvedValue(null);
    await needs('a', 'implement', '- b: its result');
    await pass();
    await ran('a');
    await needs('a', 'implement', '- b: its result');

    await pass(false);

    expect(relaunched('a')).toHaveLength(1);
    const asked = await view();
    expect(asked.items).toHaveLength(1);
    expect(asked.items[0].label.startsWith('Subtask a asks:')).toBe(true);
    expect(asked.state).toBe('waiting');
    expect(asked.stateReason?.code).toBe('NEEDS_ANSWERS');

    await flow.app.app
      .get(CommandService)
      .submit('answer', KEY, { answers: [{ kind: 'question', id: asked.items[0].id, body: 'Build it in a.' }] });
    await flow.app.app.get(CommandService).idle();
    await flow.app.pipeline.whenIdle(KEY);

    expect(relaunched('a')).toHaveLength(2);
    expect(await handoff()).toContain('Build it in a.');
    expect(await handoff()).not.toContain(NOBODY);
    expect(await documents().latestBody(KEY, 'contract')).toContain('- subtask a: Build it in a.');
    const after = await view();
    expect(after.items).toEqual([]);
    expect(after.stateReason?.code).not.toBe('NEEDS_ANSWERS');
  });

  it('sends the planner answer to a repeated refused need without asking the person', async () => {
    await seedEpic([task('a'), task('b', ['a'])]);
    jest
      .spyOn(flow.app.app.get(SubtaskPort), 'askAbout')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('Build it in this task.');
    await needs('a', 'implement', '- b: its result');
    await pass();
    await ran('a');
    await needs('a', 'implement', '- b: its result');

    await pass(false);

    expect(relaunched('a')).toHaveLength(2);
    expect(await handoff()).toContain('Build it in this task.');
    expect((await view()).items).toEqual([]);
    expect(await documents().latestBody(KEY, 'subtask_questions')).toBeFalsy();
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
