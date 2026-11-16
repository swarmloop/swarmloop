import 'reflect-metadata';
import { parseSubtasks, type Subtask } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { CommitStep } from '../steps/commit/commit.step';
import { NOT_DELIVERED } from '../steps/commit/commit-delivered';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { git, save } from './runs.spec-helpers';

const KEY = 'PROJ-440';
const FEATURE = `feature/${KEY}-ship-the-field`;

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

describe('an unchanged tree is delivered or returned, never failed', () => {
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

  async function tick(): Promise<void> {
    await flow.tick();
    await flow.app.pipeline.whenIdle(KEY);
    await assertInvariants(flow.app);
  }

  async function seedEpic(tasks: Subtask[]): Promise<void> {
    const parent = await save(runs(), KEY, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    await runs().saveRun(parent);
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(parent, 'subtasks', `${JSON.stringify(tasks)}\n`);
  }

  const statuses = async () =>
    Object.fromEntries(
      parseSubtasks(await documents().latestBody(KEY, 'subtasks')).map((item) => [item.id, item.status]),
    );

  /** The subtask run ends done with the documents its last visits wrote. */
  async function end(id: string, body: Record<string, string>): Promise<void> {
    const run = (await runs().findRun(`${KEY}-${id}`))!;
    for (const [kind, text] of Object.entries(body)) await documents().putDocument(run, kind, text);
    writeRunState(run, { status: 'done', currentStep: 'done' });
    await runs().saveRun(run);
  }

  it('skips a task a sibling already delivered, with the note, and its dependents go on', async () => {
    await seedEpic([task('a'), task('b', ['a'])]);
    await flow.app.pipeline.step('implement', KEY);
    await tick();

    await end('a', { commit: 'already delivered: src/shared.ts\n' });
    await flow.app.pipeline.step('implement', KEY);
    await tick();
    expect(await statuses()).toEqual({ a: 'skipped', b: 'running' });
    const note = parseSubtasks(await documents().latestBody(KEY, 'subtasks'))[0].note;
    expect(note).toBe('already delivered: src/shared.ts');

    await end('b', {});
    await flow.app.pipeline.step('implement', KEY);
    await tick();
    expect(await statuses()).toEqual({ a: 'skipped', b: 'green' });
  });

  describe('the commit step on a tree nothing changed', () => {
    /** The branch is on the base and not on origin: nothing to push, and nothing to commit. */
    async function unchangedRun(): Promise<void> {
      await flow.begin('merge-request');
      git(flow.tree, ['reset', '--hard', 'main']);
      git(flow.tree, ['push', 'origin', `:${FEATURE}`]);
      const run = (await runs().findRun(KEY))!;
      writeRunState(run, { status: 'waiting', currentStep: 'commit' });
      await runs().saveRun(run);
    }

    it('returns to implement with the issue when the reviews do not say the behavior is in the tree', async () => {
      await unchangedRun();
      const run = (await runs().findRun(KEY))!;
      await documents().putDocument(run, 'review_requirements', 'decision: return\n- missing: 1. Ship the field\n');

      await flow.app.app.get(CommitStep).execute(KEY);

      const returned = (await runs().findRun(KEY))!;
      expect(returned.currentStep).toBe('implement');
      expect(returned.status).toBe('waiting');
      await flow.app.pipeline.runThrough(KEY);
      await tick();
      expect(await documents().latestBody(KEY, 'issues')).toContain(NOT_DELIVERED);
      expect(await documents().latestBody(KEY, 'merge_request')).toBeNull();
    });

    it('ends done with no merge request when every reviewer passed and the review names where it is', async () => {
      await unchangedRun();
      const run = (await runs().findRun(KEY))!;
      await documents().putDocument(
        run,
        'review_requirements',
        'decision: ok\n- met: 1. Ship the field (src/readme.ts)\n',
      );

      await flow.app.app.get(CommitStep).execute(KEY);
      await tick();

      expect((await runs().findRun(KEY))?.status).toBe('done');
      expect(await documents().latestBody(KEY, 'commit')).toBe('already delivered: src/readme.ts\n');
      expect(await documents().latestBody(KEY, 'merge_request')).toBeNull();
    });
  });
});

describe('a run on the real merge request step opens a request only for work', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, { realHost: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);

  /** The run waits at commit with the reviews of a requirements review that agrees and a quality review that passed. */
  async function atCommit(): Promise<void> {
    await flow.begin('merge-request');
    const run = (await runs().findRun(KEY))!;
    writeRunState(run, { status: 'waiting', currentStep: 'commit' });
    await runs().saveRun(run);
    await documents().putDocument(
      run,
      'review_requirements',
      'decision: ok\n- met: 1. Ship the field (src/readme.ts)\n',
    );
    await documents().putDocument(run, 'review_quality', 'decision: ok\n');
  }

  it('ends done with no merge request when implement reverted its change and the review agrees', async () => {
    await atCommit();
    git(flow.tree, ['reset', '--hard', 'main']);
    git(flow.tree, ['push', '--force', 'origin', FEATURE]);

    await flow.app.app.get(CommitStep).execute(KEY);
    await flow.tick();
    await flow.app.pipeline.whenIdle(KEY);

    expect((await runs().findRun(KEY))?.status).toBe('done');
    expect(await documents().latestBody(KEY, 'commit')).toBe('already delivered: src/readme.ts\n');
    expect(await documents().latestBody(KEY, 'merge_request')).toBeNull();
    expect(flow.host.openAsks).toBe(0);
  });

  it('opens the request of a run with one commit ahead', async () => {
    await atCommit();

    await flow.app.app.get(CommitStep).execute(KEY);
    await flow.app.pipeline.step('merge-request', KEY);

    expect(flow.host.opened).toBe(1);
    expect(await documents().latestBody(KEY, 'merge_request')).toContain('https://gitlab.example/');
  });

  it('fails with the host message when the host refuses the request', async () => {
    await atCommit();
    flow.host.refuseOpen('Validation Failed: head is invalid');

    await flow.app.app.get(CommitStep).execute(KEY);
    const refused = await flow.app.pipeline.step('merge-request', KEY);

    expect(refused.exitCode).toBe(1);
    expect(refused.message).toContain('Validation Failed: head is invalid');
    expect((await runs().findRun(KEY))?.status).toBe('failed');
    expect(await documents().latestBody(KEY, 'merge_request')).toBeNull();
  });
});
