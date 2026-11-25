import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CommandService } from '../pipeline/command.service';
import { BacklogRepository } from '../history/backlog.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { remoteProject } from '../integrations/code-host/remote-project';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { FAKE_MODEL_KEY } from './env.spec-helpers';
import { createFlowHarness } from './flow-harness';
import { git } from './runs.spec-helpers';

const KEY = 'b01';
const DEFAULT_BRANCH = `feature/${KEY}-ship-the-field`;
const OWNER = 'owner';
const BACKLOG = 'shop';
const ROUNDS = 40;

/** The files each task writes: a and c change the same one. */
const FILES: Record<string, string> = { a: 'src/shared.ts', b: 'src/b.ts', c: 'src/shared.ts' };

describe('a backlog with one milestone carries every task to the default branch', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let accepted: string[];
  let project: string;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, {
      env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
      realImplement: false,
      realReview: false,
    });
    const accept = flow.app.app.get(CommandService).accept.bind(flow.app.app.get(CommandService));
    accepted = [];
    jest.spyOn(flow.app.app.get(CommandService), 'accept').mockImplementation((type, key, payload, options) => {
      accepted.push(type);
      return accept(type, key, payload, options);
    });
    // The origin is an url, so the backlog layer reads a project from it; the fake host reads and merges in the same bare repository.
    const clone = join(flow.app.root, 'demo');
    const url = `file://${join(flow.app.root, 'demo.git')}`;
    git(clone, ['remote', 'set-url', 'origin', url]);
    project = remoteProject(url).project;
    flow.host.defaultBranchPasses();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.app.app.get(CommandService).idle();
    await flow.close();
  });

  const documents = () => flow.app.app.get(DocumentRepository);
  const runs = () => flow.app.app.get(RunRepository);
  const backlogs = () => flow.app.app.get(BacklogRepository);

  /** The work of a task's run, as its steps leave it: a branch with one commit, its merge request and a passing pipeline; the run is done. */
  async function deliver(slug: string, runKey: string): Promise<void> {
    const run = (await runs().findRun(runKey))!;
    const clone = join(flow.app.root, 'demo');
    const tree = join(flow.app.root, 'worktrees', runKey, 'demo');
    const branch = `feature/${runKey}`;
    git(clone, ['fetch', 'origin']);
    mkdirSync(join(tree, '..'), { recursive: true });
    git(clone, ['worktree', 'add', '-b', branch, tree, `origin/${DEFAULT_BRANCH}`]);
    mkdirSync(join(tree, 'src'), { recursive: true });
    writeFileSync(join(tree, FILES[slug]), `export const ${slug} = '${runKey}';\n`);
    git(tree, ['add', FILES[slug]]);
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
    await documents().putDocument(run, 'merge_request', renderMergeRequest([record]));
    await documents().putDocument(run, 'pipeline_ref', `project: ${project}\nref: ${branch}\nsha: ${sha}\n`);
    run.codeHost = 'gitlab';
    writeRunState(run, { status: 'done', currentStep: 'done' });
    await storeRun(runs(), run);
  }

  async function setUp() {
    const { actions } = flow.backlog();
    await actions.createBacklog(OWNER, { name: BACKLOG, repositories: ['demo'], mergeMode: 'green' });
    await actions.proposeMilestone(OWNER, BACKLOG, { title: 'Ship the shop', goal: 'Customers can order.' });
    await actions.addRequirements(OWNER, BACKLOG, 1, { texts: ['Orders can be placed', 'Orders can be listed'] });
    const task = (id: string, rest: { depends?: string[]; covers: string[] }) => ({
      id,
      title: `Task ${id}`,
      description: `Do ${id}.`,
      repositories: ['demo'],
      files: [FILES[id]],
      proof: [`${id}.spec.ts`],
      milestone: 1,
      ...rest,
    });
    await actions.addTasks(OWNER, BACKLOG, [
      task('a', { covers: ['M1.R1'] }),
      task('b', { depends: ['a'], covers: ['M1.R2'] }),
      task('c', { covers: ['M1.R2'] }),
    ]);
    await actions.runMilestone(OWNER, BACKLOG, 1);
    return (await backlogs().findBacklog(BACKLOG))!.id as number;
  }

  /** Every pass: the scheduler starts and merges, each run it started is delivered, and the server's own pass runs. */
  async function drive(): Promise<void> {
    const { scheduler } = flow.backlog();
    const delivered = new Set<string>();
    const id = (await backlogs().findBacklog(BACKLOG))!.id as number;
    for (let round = 0; round < ROUNDS; round++) {
      await scheduler.tick();
      const tasks = await backlogs().tasks(id);
      if (tasks.every((task) => task.status === 'merged')) return;
      for (const task of tasks) {
        if (task.runKey === null || delivered.has(task.runKey) || !(await runs().findRun(task.runKey))) continue;
        await deliver(task.slug, task.runKey);
        delivered.add(task.runKey);
      }
      await flow.tick();
    }
    const shown = (await backlogs().tasks(id)).map((task) => `${task.slug}: ${task.status} ${task.note}`);
    throw new Error(`the tasks did not all merge in ${ROUNDS} passes: ${shown.join(' | ')}`);
  }

  it('merges every task once, closes both requirements and says the milestone is ready, with only the owner acting', async () => {
    const id = await setUp();

    await drive();

    const tasks = await backlogs().tasks(id);
    expect(tasks.map((task) => [task.slug, task.status])).toEqual([
      ['a', 'merged'],
      ['b', 'merged'],
      ['c', 'merged'],
    ]);
    // One run and one merge request each.
    expect(new Set(tasks.map((task) => task.runKey)).size).toBe(3);
    expect(flow.host.opened).toBe(3);
    expect(flow.host.merged.size).toBe(3);
    expect(flow.launched).toEqual(tasks.map((task) => task.runKey));
    // Every merged commit is on the default branch, and a merged before b and c.
    const clone = join(flow.app.root, 'demo');
    git(clone, ['fetch', 'origin']);
    const onMain = git(clone, ['rev-list', `origin/${DEFAULT_BRANCH}`]).split('\n');
    for (const task of tasks) expect(onMain).toContain(task.merged.demo);
    const order = tasks.map((task) => onMain.indexOf(task.merged.demo));
    expect(order[0]).toBeGreaterThan(order[1]);
    expect(order[0]).toBeGreaterThan(order[2]);
    // Both requirements are closed and the milestone is ready.
    expect((await backlogs().requirements(id)).map((requirement) => requirement.status)).toEqual(['closed', 'closed']);
    const events = await backlogs().events(id, 100);
    expect(events.filter((event) => event.kind === 'milestone-ready')).toHaveLength(1);
    // No person acted but the owner: the setup and the run of the milestone, and the only command is the start of each run.
    expect(events.filter((event) => event.kind === 'run-needs-person')).toEqual([]);
    const actions = events.filter((event) => event.kind === 'action').map((event) => event.facts);
    expect(actions.map((facts) => facts.action).sort()).toEqual([
      'add requirements',
      'add tasks',
      'create backlog',
      'propose milestone',
      'run milestone',
    ]);
    expect(new Set(actions.map((facts) => facts.who))).toEqual(new Set([OWNER]));
    expect(new Set(accepted)).toEqual(new Set(['start']));
  });
});
