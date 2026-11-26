import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { attachmentsMount, briefMounts } from '../agent/agent-args';
import { AppConfig } from '../config/env';
import { AttachmentStore } from '../history/attachment-store';
import { attachmentsDir, root } from '../history/run-paths';
import { BacklogChatService } from '../api/backlog-chat.service';
import { BacklogChatRepository } from '../history/backlog-chat.repository';
import { BacklogRepository } from '../history/backlog.repository';
import { CheckCommandRepository } from '../history/check-command.repository';
import { CommandRepository } from '../history/command.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { checkOutputPath } from '../core/check-output';
import { ERROR_CODES } from '../contract/error-codes';
import { REASON } from '../contract/reason-words';
import type { BacklogTurnResult } from '../agent-result/definitions/backlog-turn';
import { remoteProject } from '../integrations/code-host/remote-project';
import { plannerChatKey } from '../pipeline/backlog/planner/planner-chat-key';
import { sessionFileName, sessionHome } from '../history/session-group';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { BacklogPlanner } from '../pipeline/backlog/planner/backlog-planner';
import { CommandService } from '../pipeline/command.service';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { FAKE_MODEL_KEY } from './env.spec-helpers';
import { createFlowHarness } from './flow-harness';
import { BlockAgentRunner } from './result-answer';
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
  /** What each planner turn was launched with: its prompt, and the files mount its sandbox gets. */
  let launches: {
    prompt: string;
    mount: ReturnType<typeof attachmentsMount>;
    sessionFile?: string;
  }[];

  beforeEach(async () => {
    launches = [];
    const blocks = scriptedBacklogTurns({
      title: 'Ship the shop',
      goal: 'Customers can order.',
      requirements: ['Orders can be placed', 'Orders can be listed'],
      tasks: TASKS,
    });
    const scripted = blocks.run.bind(blocks);
    blocks.run = (input) => {
      if (input.step === 'backlog-plan') {
        const config = flow.app.app.get(AppConfig);
        launches.push({
          prompt: input.prompt ?? '',
          mount: attachmentsMount(attachmentsDir(config, input.runKey ?? '')),
          sessionFile: input.sessionFile,
        });
      }
      return scripted(input);
    };
    flow = await createFlowHarness(KEY, {
      env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
      realImplement: false,
      realReview: false,
      blocks,
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
    await storeRun(runs(), run);
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

  it('gives a file sent with a message to the next planner turn, read only', async () => {
    const { actions } = flow.backlog();
    await actions.createBacklog(OWNER, { name: BACKLOG, repositories: REPOSITORIES, mergeMode: 'green' });
    const file = await flow.app.app.get(AttachmentStore).stage('mockup.png', Buffer.from('png'));
    const chat = flow.app.app.get(BacklogChatService);

    const sent = await chat.post(OWNER, BACKLOG, 'Plan the shop like this mockup.', 'with-file', [file.id]);
    await flow.app.app.get(BacklogPlanner).whenIdle();

    expect(sent.messages[0].attachments).toEqual([file]);
    expect((await chat.chat(BACKLOG)).messages[0].attachments).toEqual([file]);
    expect(launches).toHaveLength(1);
    expect(launches[0].prompt).toContain('Attachments:');
    expect(launches[0].prompt).toContain('mockup.png');
    expect(launches[0].mount).toMatchObject({ containerPath: '/work/brief/attachments', readonly: true });
  });

  it('runs two turns of one backlog on one chat: the second gets the changes, and both read the brief files', async () => {
    const { actions } = flow.backlog();
    await actions.createBacklog(OWNER, { name: BACKLOG, repositories: REPOSITORIES, mergeMode: 'green' });
    const id = (await backlogs().findBacklog(BACKLOG))!.id as number;
    const chat = flow.app.app.get(BacklogChatService);
    const planner = flow.app.app.get(BacklogPlanner);

    await chat.post(OWNER, BACKLOG, 'Plan the shop with orders.', 'first');
    await planner.whenIdle();
    await chat.post(OWNER, BACKLOG, 'Thanks, carry on.', 'second');
    await planner.whenIdle();

    expect(launches).toHaveLength(2);
    const [first, second] = launches;
    const session = sessionFileName(plannerChatKey(id), 'backlog-plan');
    expect(first.sessionFile).toMatch(new RegExp(`${session}$`));
    expect(second.sessionFile).toBe(first.sessionFile);
    expect(first.prompt).toContain('You keep one chat for this backlog');
    expect(second.prompt).toContain('Thanks, carry on.');
    expect(second.prompt).not.toContain('You keep one chat for this backlog');
    const [mount] = briefMounts(
      agentStateDir(root(flow.app.app.get(AppConfig)), plannerChatKey(id), sessionHome('backlog-plan')),
      'backlog-plan',
      [],
    );
    expect(mount).toMatchObject({ containerPath: '/work/brief', readonly: true });
    expect(existsSync(join(mount.hostPath, 'decisions.md'))).toBe(true);
    expect(existsSync(join(mount.hostPath, 'tasks', 'a.md'))).toBe(true);
  });
});

describe('the planner acts on a run of its backlog that waits for a person', () => {
  const LINT_OUTPUT = 'src/a.ts: unused variable lintBroke';
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  /** The prompts of the planner turns, in order. */
  let prompts: string[];
  /** What the next turn answers, by its prompt; an empty turn when it answers nothing. */
  let answer: (prompt: string) => BacklogTurnResult;

  beforeEach(async () => {
    prompts = [];
    answer = () => ({ say: '', actions: [] });
    const blocks = new BlockAgentRunner();
    const base = blocks.run.bind(blocks);
    blocks.run = (input) => {
      if (input.step !== 'backlog-plan') return base(input);
      prompts.push(input.prompt ?? '');
      return new BlockAgentRunner({ 'backlog-plan': [{ block: answer(input.prompt ?? '') }] }).run(input);
    };
    flow = await createFlowHarness(KEY, {
      env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
      realImplement: false,
      realReview: false,
      blocks,
    });
    const url = `file://${join(flow.app.root, 'demo.git')}`;
    git(join(flow.app.root, 'demo'), ['remote', 'set-url', 'origin', url]);
    remoteProject(url);
    flow.host.defaultBranchPasses();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.app.app.get(CommandService).idle();
    await flow.close();
  });

  /** A started task `a` whose run is `blocked` at `step`; returns the backlog id and the run. */
  async function blockedTask(step: string) {
    const { actions, scheduler } = flow.backlog();
    await actions.createBacklog(OWNER, { name: BACKLOG, repositories: ['demo'], mergeMode: 'green' });
    await actions.proposeMilestone(OWNER, BACKLOG, { title: 'Ship the shop', goal: 'Customers can order.' });
    await actions.addRequirements(OWNER, BACKLOG, 1, { texts: ['Orders can be placed'] });
    await actions.addTasks(OWNER, BACKLOG, [{ ...TASKS[0], repositories: ['demo'], depends: [] }]);
    await actions.runMilestone(OWNER, BACKLOG, 1);
    const id = (await backlogs().findBacklog(BACKLOG))!.id as number;
    await scheduler.tick();
    const runKey = (await backlogs().tasks(id))[0].runKey as string;
    await flow.app.pipeline.whenIdle(runKey);
    await flow.app.app.get(CommandService).idle();
    const run = (await runs().findRun(runKey))!;
    writeRunState(run, {
      status: 'blocked',
      currentStep: step,
      reason: { code: REASON.loopLimit, message: 'checks ran 3 times (MAX_RETURNS)' },
    });
    await storeRun(runs(), run);
    return { id, run };
  }

  const backlogs = () => flow.app.app.get(BacklogRepository);
  const runs = () => flow.app.app.get(RunRepository);

  it('reads the output of the failed checks and replays the run from implement with an instruction', async () => {
    const { id, run } = await blockedTask('checks');
    await flow.app.app.get(CheckCommandRepository).add({
      runId: run.id,
      attemptId: 'att-1',
      repo: 'demo',
      command: 'npm run lint',
      name: 'lint',
      commandIndex: 0,
      status: 'failed',
      exitCode: 1,
    });
    const output = checkOutputPath(root(flow.app.app.get(AppConfig)), run.key, 'checks', 'att-1', 0);
    mkdirSync(join(output, '..'), { recursive: true });
    writeFileSync(output, LINT_OUTPUT);
    answer = (prompt) =>
      prompt.includes(LINT_OUTPUT)
        ? {
            say: 'The lint check failed; I replay implement.',
            actions: [
              {
                action: 'replay',
                run: run.key,
                step: 'implement',
                instruction: 'Remove the unused variable lintBroke.',
                reason: 'the lint check failed',
              },
            ],
          }
        : { say: '', actions: [] };

    await flow.backlog().scheduler.tick();
    await flow.app.app.get(BacklogPlanner).whenIdle();
    await flow.app.app.get(CommandService).idle();

    expect(prompts[0]).toContain(LINT_OUTPUT);
    const refused = (await backlogs().events(id, 100)).filter((event) => event.kind === 'command-refused');
    expect(refused).toEqual([]);
    const replayed = (await runs().findRun(run.key))!;
    expect(replayed.prompt).toContain('Remove the unused variable lintBroke.');
    const instructions = await flow.app.app.get(DocumentRepository).latestBody(run.key, 'instructions:implement');
    expect(instructions).toBe('Remove the unused variable lintBroke.');
  });

  it('resumes a blocked part of an epic, and the part goes on', async () => {
    const { id, run } = await blockedTask('implement');
    run.split = true;
    writeRunState(run, {
      status: 'blocked',
      currentStep: 'implement',
      reason: { code: ERROR_CODES.SUBTASK_BLOCKED, message: 'subtask a is blocked' },
    });
    await storeRun(runs(), run);
    await runs().openSubtask(`${run.key}-a`, run.id, 'a');
    const part = (await runs().findRun(`${run.key}-a`))!;
    writeRunState(part, {
      status: 'blocked',
      currentStep: 'implement',
      reason: { code: REASON.loopLimit, message: 'checks ran 3 times (MAX_RETURNS)' },
    });
    await storeRun(runs(), part);
    answer = (prompt) =>
      prompt.includes(part.key)
        ? { say: 'I resume the part.', actions: [{ action: 'resume', run: part.key, reason: 'the part is blocked' }] }
        : { say: '', actions: [] };

    await flow.backlog().scheduler.tick();
    await flow.app.app.get(BacklogPlanner).whenIdle();
    await flow.app.app.get(CommandService).idle();
    await flow.app.pipeline.whenIdle(part.key);

    const refused = (await backlogs().events(id, 100)).filter((event) => event.kind === 'command-refused');
    expect(refused).toEqual([]);
    const resumed = await flow.app.app.get(CommandRepository).latestOfType(part.id, 'resume');
    expect(resumed).toMatchObject({ actor: OWNER, state: 'succeeded' });
    expect(JSON.parse(resumed?.result ?? 'null')).toEqual({ value: { key: part.key, status: 'started' } });
  });
});

describe('a message that comes while the planner works is answered in that turn', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  /** The prompts of the planner launches, in order. */
  let prompts: string[];

  beforeEach(async () => {
    prompts = [];
    const blocks = new BlockAgentRunner();
    const base = blocks.run.bind(blocks);
    blocks.run = async (input) => {
      if (input.step !== 'backlog-plan') return base(input);
      prompts.push(input.prompt ?? '');
      if (prompts.length === 1) {
        await flow.app.app.get(BacklogChatService).post(OWNER, BACKLOG, 'And add a search box.', 'second');
      }
      const say = prompts.length === 1 ? 'First answer.' : 'Both answered.';
      return new BlockAgentRunner({ 'backlog-plan': [{ block: { say, actions: [] } }] }).run(input);
    };
    flow = await createFlowHarness(KEY, {
      env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
      realImplement: false,
      realReview: false,
      blocks,
    });
    const url = `file://${join(flow.app.root, 'demo.git')}`;
    git(join(flow.app.root, 'demo'), ['remote', 'set-url', 'origin', url]);
    remoteProject(url);
    flow.host.defaultBranchPasses();
  });

  afterEach(async () => {
    await flow.close();
  });

  it('gives the message to the running turn in one follow-up and applies the answer to it', async () => {
    await flow.backlog().actions.createBacklog(OWNER, { name: BACKLOG, repositories: ['demo'], mergeMode: 'green' });
    const chat = flow.app.app.get(BacklogChatService);

    await chat.post(OWNER, BACKLOG, 'Plan the shop.', 'first');
    await flow.app.app.get(BacklogPlanner).whenIdle();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('And add a search box.');
    const shown = await chat.chat(BACKLOG);
    expect(shown.turns.map((turn) => turn.status)).toEqual(['done']);
    expect(shown.messages.map((message) => [message.author, message.text, message.state])).toEqual([
      ['person', 'Plan the shop.', 'answered'],
      ['person', 'And add a search box.', 'answered'],
      ['planner', 'Both answered.', undefined],
    ]);
  });
});
