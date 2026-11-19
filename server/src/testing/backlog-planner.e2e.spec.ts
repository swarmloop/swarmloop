import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BacklogChatService } from '../api/backlog-chat.service';
import { BacklogChatRepository } from '../history/backlog-chat.repository';
import { BacklogRepository } from '../history/backlog.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { remoteProject } from '../integrations/code-host/remote-project';
import { BacklogPlanner } from '../pipeline/backlog/planner/backlog-planner';
import { CommandService } from '../pipeline/command.service';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { FAKE_MODEL_KEY } from './env.spec-helpers';
import { createFlowHarness } from './flow-harness';
import { git } from './runs.spec-helpers';
import { scriptedBacklogTurns } from './test-app-steps';

const KEY = 'b02';
const DEFAULT_BRANCH = `feature/${KEY}-ship-the-field`;
const OWNER = 'owner';
const BACKLOG = 'shop';
const REPOSITORIES = ['demo', 'api'];
const ROUNDS = 40;

const TASKS = [
  { id: 'a', repository: 'demo', covers: ['M1.R1'], depends: [] as string[] },
  { id: 'b', repository: 'api', covers: ['M1.R2'], depends: ['a'] },
].map((task) => ({
  id: task.id,
  title: `Task ${task.id}`,
  description: `Do ${task.id}.`,
  repositories: [task.repository],
  files: [`src/${task.id}.ts`],
  proof: [`${task.id}.spec.ts`],
  milestone: 1,
  covers: task.covers,
  depends: task.depends,
}));

describe('a backlog of two repositories is planned, run and accepted through the planner', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let project: string;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, {
      env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
      realImplement: false,
      realReview: false,
      blocks: scriptedBacklogTurns({
        title: 'Ship the shop',
        goal: 'Customers can order.',
        requirements: ['Orders can be placed', 'Orders can be listed'],
        tasks: TASKS,
      }),
    });
    // The two checkouts share one origin, which the fake host reads and merges in.
    const url = `file://${join(flow.app.root, 'demo.git')}`;
    git(flow.app.root, ['clone', url, 'api']);
    for (const name of REPOSITORIES) git(join(flow.app.root, name), ['remote', 'set-url', 'origin', url]);
    project = remoteProject(url).project;
    flow.host.defaultBranchPasses();
    flow.backlog();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.app.app.get(CommandService).idle();
    await flow.close();
  });

  const backlogs = () => flow.app.app.get(BacklogRepository);
  const runs = () => flow.app.app.get(RunRepository);

  /** The work of a task's run, as its steps leave it: a branch with one commit, its merge request and a passing pipeline; the run is done. */
  async function deliver(slug: string, repository: string, runKey: string): Promise<void> {
    const run = (await runs().findRun(runKey))!;
    const clone = join(flow.app.root, repository);
    const tree = join(flow.app.root, 'worktrees', runKey, repository);
    const branch = `feature/${runKey}`;
    git(clone, ['fetch', 'origin']);
    mkdirSync(join(tree, '..'), { recursive: true });
    git(clone, ['worktree', 'add', '-b', branch, tree, `origin/${DEFAULT_BRANCH}`]);
    mkdirSync(join(tree, 'src'), { recursive: true });
    writeFileSync(join(tree, `src/${slug}.ts`), `export const ${slug} = '${runKey}';\n`);
    git(tree, ['add', `src/${slug}.ts`]);
    git(tree, ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-m', `feat: ${slug}`]);
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
    const documents = flow.app.app.get(DocumentRepository);
    await documents.putDocument(run, 'merge_request', renderMergeRequest([record]));
    await documents.putDocument(run, 'pipeline_ref', `project: ${project}\nref: ${branch}\nsha: ${sha}\n`);
    run.codeHost = 'gitlab';
    writeRunState(run, { status: 'done', currentStep: 'done' });
    await runs().saveRun(run);
  }

  /** Every pass: the scheduler starts and merges, each run it started is delivered, and the server's own pass runs. */
  async function drive(id: number): Promise<void> {
    const { scheduler } = flow.backlog();
    const delivered = new Set<string>();
    for (let round = 0; round < ROUNDS; round++) {
      await scheduler.tick();
      const tasks = await backlogs().tasks(id);
      if (tasks.every((task) => task.status === 'merged')) return;
      for (const task of tasks) {
        if (task.runKey === null || delivered.has(task.runKey) || !(await runs().findRun(task.runKey))) continue;
        await deliver(task.slug, task.repositories[0], task.runKey);
        delivered.add(task.runKey);
      }
      await flow.tick();
    }
    throw new Error(`the tasks did not all merge in ${ROUNDS} passes`);
  }

  it('proposes on a message, starts only on the owner, and accepts the milestone with no other person', async () => {
    const { actions } = flow.backlog();
    await actions.createBacklog(OWNER, { name: BACKLOG, repositories: REPOSITORIES, mergeMode: 'green' });
    const id = (await backlogs().findBacklog(BACKLOG))!.id as number;
    const planner = flow.app.app.get(BacklogPlanner);

    await flow.app.app.get(BacklogChatService).post(OWNER, BACKLOG, 'Plan the shop with orders.', 'first');
    await planner.whenIdle();

    // The planner proposed the milestone, and nothing starts before the owner's start.
    expect((await backlogs().milestones(id)).map((milestone) => milestone.status)).toEqual(['proposed']);
    const chat = await flow.app.app.get(BacklogChatService).chat(BACKLOG);
    expect(chat.messages.map((message) => message.author)).toEqual(['person', 'planner']);
    expect(chat.turns.map((turn) => turn.status)).toEqual(['done']);
    await flow.tick();
    expect((await backlogs().tasks(id)).map((task) => task.runKey)).toEqual([null, null]);

    await actions.runMilestone(OWNER, BACKLOG, 1);
    await drive(id);
    await planner.whenIdle();
    await flow.tick();

    const milestones = await backlogs().milestones(id);
    expect(milestones.map((milestone) => milestone.status)).toEqual(['accepted']);
    expect((await backlogs().requirements(id)).map((requirement) => requirement.status)).toEqual(['closed', 'closed']);
    const events = await backlogs().events(id, 100);
    expect(events.filter((event) => event.kind === 'run-needs-person')).toEqual([]);
    const records = events.filter((event) => event.kind === 'action').map((event) => event.facts);
    expect(new Set(records.map((facts) => facts.who))).toEqual(new Set([OWNER]));
    const accepted = records.find((facts) => facts.action === 'accept milestone');
    expect(accepted?.via).toBe('the planner');
    expect(records.filter((facts) => facts.via === 'the planner').map((facts) => facts.action)).toContain('add tasks');
    expect(await flow.app.app.get(BacklogChatRepository).turnsByStatus(['failed'])).toEqual([]);
  });
});
