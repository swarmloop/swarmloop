import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CommandService } from '../pipeline/command.service';
import { parseSubtasks, type Subtask } from '../contract/subtask';
import { FetchFailed } from '../core/swarmloop-error';
import { BacklogRepository } from '../history/backlog.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { remoteProject } from '../integrations/code-host/remote-project';
import { branchName, summaryForBranch } from '../git/naming/git-names';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { EventFacts } from '../pipeline/backlog/planner/event-facts';
import { FAKE_MODEL_KEY } from './env.spec-helpers';
import { createFlowHarness } from './flow-harness';
import { git, save } from './runs.spec-helpers';

const KEY = 'PROJ-480';
const FEATURE = `feature/${KEY}-ship-the-field`;
const TITLE_FILES = { '.swarmloop.json': JSON.stringify({ version: 1, git: { title: 'Merge {task}' } }) };

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

/** The subject and the parent count of a commit on origin. */
function commitOf(clone: string, sha: string): { subject: string; parents: number } {
  const [subject, parents] = git(clone, ['log', '-1', '--format=%s%n%P', sha]).split('\n');
  return { subject, parents: parents.split(' ').filter(Boolean).length };
}

describe('a task merges with the method the repository allows', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.app.app.get(CommandService).idle();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);
  const clone = () => join(flow.app.root, 'demo');

  describe("an epic's tasks into the feature branch", () => {
    const task = (id: string): Subtask => ({
      id,
      title: `Task ${id}`,
      description: `Do ${id}.`,
      depends: [],
      files: [`src/${id}.ts`],
      proof: `${id}.spec.ts`,
      status: 'waiting',
    });

    const statuses = async () =>
      Object.fromEntries(
        parseSubtasks(await documents().latestBody(KEY, 'subtasks')).map((item) => [item.id, item.status]),
      );

    async function pass(): Promise<void> {
      await flow.app.app.get(CommandService).idle();
      await flow.app.pipeline.whenIdle(KEY);
      await flow.app.pipeline.step('implement', KEY);
      await flow.app.app.get(CommandService).idle();
      await flow.tick();
      await flow.app.app.get(CommandService).idle();
      for (const item of parseSubtasks(await documents().latestBody(KEY, 'subtasks'))) {
        await flow.app.pipeline.whenIdle(`${KEY}-${item.id}`);
      }
    }

    async function start(repoFiles?: Record<string, string>): Promise<void> {
      flow = await createFlowHarness(KEY, {
        realHost: true,
        taskWorktrees: true,
        repoFiles,
        fakeHost: { mergeMethods: ['merge'] },
      });
      const parent = await save(runs(), KEY, 'implement', 'waiting');
      parent.split = true;
      parent.projects = 'demo\n';
      parent.codeHost = 'gitlab';
      await storeRun(runs(), parent);
      await documents().putDocument(parent, 'requirements', requirements);
      await documents().putDocument(parent, 'repos', 'demo\n');
      await documents().putDocument(parent, 'subtasks', `${JSON.stringify([task('a'), task('b')])}\n`);
      await pass();
    }

    /** The task's branch gets one commit and a merge request into the feature branch; its run is done. */
    async function deliver(id: string): Promise<number> {
      const run = (await runs().findRun(`${KEY}-${id}`))!;
      const branch = branchName(run.key, summaryForBranch(requirements, run.key));
      const tree = join(flow.app.root, 'worktrees', run.key, 'demo');
      git(clone(), ['fetch', 'origin']);
      mkdirSync(join(tree, '..'), { recursive: true });
      git(clone(), ['worktree', 'add', '-b', branch, tree, `origin/${FEATURE}`]);
      mkdirSync(join(tree, 'src'), { recursive: true });
      writeFileSync(join(tree, 'src', `${id}.ts`), `export const ${id} = 1;\n`);
      git(tree, ['add', `src/${id}.ts`]);
      git(tree, ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-m', `feat: ${id}`]);
      git(tree, ['push', 'origin', branch]);
      flow.host.ci.pass(git(tree, ['rev-parse', 'HEAD']));
      const { record } = await flow.host.openMergeRequest({
        project: 'demo',
        source: branch,
        target: FEATURE,
        title: id,
        summary: '',
        draft: false,
      });
      await documents().putDocument(run, 'requirements', requirements);
      await documents().putDocument(run, 'repos', 'demo\n');
      await documents().putDocument(run, 'implementation', '- shipped the task\n');
      run.prompt = `branch: ${FEATURE}\n`;
      await documents().putDocument(run, 'merge_request', renderMergeRequest([record]));
      writeRunState(run, { status: 'done', currentStep: 'done' });
      await storeRun(runs(), run);
      return record.iid;
    }

    it('merges with merge commits titled by the title template with the task', async () => {
      await start(TITLE_FILES);
      const iid = await deliver('a');

      await pass();

      expect(await statuses()).toMatchObject({ a: 'merged' });
      expect(commitOf(clone(), flow.host.merged.get(iid)!)).toEqual({ subject: 'Merge Task a', parents: 2 });
    });

    it('merges with a merge commit and no title when the repository has no title format', async () => {
      await start();
      const iid = await deliver('a');

      await pass();

      expect(commitOf(clone(), flow.host.merged.get(iid)!)).toEqual({ subject: `merge !${iid}`, parents: 2 });
    });

    it('waits, merges nothing and does not fail the run when the allowed methods cannot be read', async () => {
      await start(TITLE_FILES);
      const iid = await deliver('a');
      jest.spyOn(flow.host, 'readMergeMethods').mockRejectedValue(new FetchFailed('the host did not answer'));

      await pass();

      expect(flow.host.merged.has(iid)).toBe(false);
      expect(await statuses()).toMatchObject({ a: 'green' });
      expect((await runs().findRun(KEY))?.status).not.toBe('failed');
    });
  });

  describe("a backlog's tasks into main", () => {
    const DEFAULT_BRANCH = `feature/b01-ship-the-field`;
    const OWNER = 'owner';

    /** The run's branch gets a commit of the part's file when given, then the commit of the task's own file; its run is done. */
    async function deliver(slug: string, runKey: string, project: string, partFile?: string): Promise<void> {
      const run = (await runs().findRun(runKey))!;
      const tree = join(flow.app.root, 'worktrees', runKey, 'demo');
      const branch = `feature/${runKey}`;
      git(clone(), ['fetch', 'origin']);
      mkdirSync(join(tree, '..'), { recursive: true });
      git(clone(), ['worktree', 'add', '-b', branch, tree, `origin/${DEFAULT_BRANCH}`]);
      // The base tip the prepare step records when it makes a worktree.
      run.baseTips = { demo: git(tree, ['rev-parse', 'HEAD']) };
      mkdirSync(join(tree, 'src'), { recursive: true });
      const identity = ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com'];
      if (partFile) {
        writeFileSync(join(tree, partFile), 'export const part = 1;\n');
        git(tree, ['add', partFile]);
        git(tree, [...identity, 'commit', '-m', 'feat: a part']);
      }
      writeFileSync(join(tree, `src/${slug}.ts`), `export const ${slug} = 1;\n`);
      git(tree, ['add', `src/${slug}.ts`]);
      git(tree, [...identity, 'commit', '-m', `feat: ${slug}`]);
      git(tree, ['push', 'origin', branch]);
      const sha = git(tree, ['rev-parse', 'HEAD']);
      flow.host.ci.pass(sha);
      const { record } = await flow.host.openMergeRequest({
        project,
        source: branch,
        target: DEFAULT_BRANCH,
        title: slug,
        summary: '',
        draft: false,
      });
      await documents().putDocument(run, 'requirements', requirements);
      await documents().putDocument(run, 'merge_request', renderMergeRequest([record]));
      await documents().putDocument(run, 'pipeline_ref', `project: ${project}\nref: ${branch}\nsha: ${sha}\n`);
      await documents().putDocument(run, 'commit', `demo\tsrc/${slug}.ts\n`);
      run.codeHost = 'gitlab';
      writeRunState(run, { status: 'done', currentStep: 'done' });
      await storeRun(runs(), run);
    }

    /** A backlog with the task `a` over `demo`, delivered by the test and merged by the backlog queue. */
    async function mergeBacklogTask(partFile?: string) {
      flow = await createFlowHarness('b01', {
        env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
        realImplement: false,
        realReview: false,
        repoFiles: TITLE_FILES,
        fakeHost: { mergeMethods: ['merge'] },
      });
      const url = `file://${join(flow.app.root, 'demo.git')}`;
      git(clone(), ['remote', 'set-url', 'origin', url]);
      const project = remoteProject(url).project;
      flow.host.defaultBranchPasses();
      const { actions, scheduler } = flow.backlog();
      await actions.createBacklog(OWNER, { name: 'shop', repositories: ['demo'], mergeMode: 'green' });
      await actions.proposeMilestone(OWNER, 'shop', { title: 'Ship the shop', goal: 'Customers can order.' });
      await actions.addRequirements(OWNER, 'shop', 1, { texts: ['Orders can be placed'] });
      await actions.addTasks(OWNER, 'shop', [
        {
          id: 'a',
          title: 'Place orders',
          description: 'Do a.',
          repositories: ['demo'],
          files: ['src/a.ts'],
          proof: ['a.spec.ts'],
          milestone: 1,
          covers: ['M1.R1'],
        },
      ]);
      await actions.runMilestone(OWNER, 'shop', 1);
      const backlogs = flow.app.app.get(BacklogRepository);
      const id = (await backlogs.findBacklog('shop'))!.id as number;

      for (let round = 0; round < 40; round++) {
        await scheduler.tick();
        const [found] = await backlogs.tasks(id);
        if (found.status === 'merged') break;
        if (found.runKey !== null && (await runs().findRun(found.runKey)) && flow.host.opened === 0) {
          await deliver(found.slug, found.runKey, project, partFile);
        }
        await flow.tick();
      }

      return { backlogs, id };
    }

    it('merges the same way, with the title template and the task title', async () => {
      const { backlogs, id } = await mergeBacklogTask();
      const [merged] = await backlogs.tasks(id);
      expect(merged.status).toBe('merged');
      git(clone(), ['fetch', 'origin']);
      expect(commitOf(clone(), merged.merged.demo)).toEqual({ subject: 'Merge Place orders', parents: 2 });
    });

    it('records the files of the whole merge, so the task-merged facts name a file a part changed outside the plan', async () => {
      const { backlogs, id } = await mergeBacklogTask('src/part.ts');

      const [merged] = await backlogs.tasks(id);
      expect(merged.status).toBe('merged');
      const files = await documents().latestBody(merged.runKey as string, 'merged_files');
      expect(files?.split('\n').sort()).toEqual(['src/a.ts', 'src/part.ts']);
      const [event] = (await backlogs.events(id, 100)).filter((found) => found.kind === 'task-merged');
      const facts = await flow.app.app.get(EventFacts).of(OWNER, event, 'turn');
      expect(facts.marks).toBe('its merge request changed files outside its plan: src/part.ts');
    });
  });
});
