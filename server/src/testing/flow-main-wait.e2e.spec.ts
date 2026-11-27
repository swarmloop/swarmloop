import 'reflect-metadata';
import { REASON } from '../contract/reason-words';
import { BacklogRepository } from '../history/backlog.repository';
import { writeRunState } from '../history/run-state';
import { PlannerRunPort } from '../pipeline/backlog/planner/planner-run-port';
import { bootEpicFlow, epicMainKit, KEY, requirements, task } from './flow-epic-main.spec-helpers';
import { checkDocker } from './check-docker.spec-helpers';
import { BlockAgentRunner } from './result-answer';
import { save } from './runs.spec-helpers';
import { storeRun } from './store-run.spec-helpers';
import { CommandService } from '../pipeline/command.service';

const HELD = { code: REASON.waitsForMain, message: 'waits for a green main of demo' };

describe('a run that waits for a green main is rebased and resumed once main is green', () => {
  let flow: Awaited<ReturnType<typeof bootEpicFlow>>;
  let sent: { type: string; key: string }[];
  const docker = checkDocker(() => 0);
  const kit = epicMainKit(() => flow);
  const { runs, documents, isIn, landOnMain, backlogPass, settleAll, stateOf, childKey, treeOf, seedEpic, ask } = kit;

  const boot = async (blocks?: BlockAgentRunner) => {
    sent = [];
    flow = await bootEpicFlow(sent, docker, undefined, blocks, false);
    // A main with no pipeline reads as no CI and passes; the wait needs a main whose pipeline fails.
    flow.host.ci.failBranch('main', 'main is red');
  };
  const rebaseKeys = () => sent.filter((command) => command.type === 'rebase').map((command) => command.key);

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.app.app.get(CommandService).idle();
    await flow.close();
  });

  it('wakes a run on main: it waits while main is not green, then is rebased onto it and resumed, with no person', async () => {
    await boot();
    const run = await save(runs(), KEY, 'implement', 'waiting');
    run.projects = 'demo\n';
    run.codeHost = 'gitlab';
    writeRunState(run, { status: 'waiting', currentStep: 'implement', reason: HELD });
    await storeRun(runs(), run);
    await documents().putDocument(run, 'requirements', requirements);
    await documents().putDocument(run, 'repos', 'demo\n');
    await kit.seedBacklog();
    const head = landOnMain('src/fix.ts', 'export const fix = 1;\n');

    await backlogPass();
    expect(rebaseKeys()).toEqual([]);
    expect(await stateOf(KEY)).toMatchObject({ state: 'waiting', reason: { code: REASON.waitsForMain } });

    flow.host.defaultBranchPasses();
    await backlogPass();
    await settleAll();

    expect(rebaseKeys()).toEqual([KEY]);
    expect(isIn(flow.tree, head)).toBe(true);
    expect((await stateOf(KEY)).reason?.code).not.toBe(REASON.waitsForMain);
    expect(sent.every((command) => ['rebase', 'resume'].includes(command.type))).toBe(true);
  });

  it('wakes an epic whose part waits for a green main through its main move, which moves the part and resumes it', async () => {
    await boot();
    await seedEpic([task('a')]);
    const part = (await runs().findRun(childKey('a')))!;
    writeRunState(part, { status: 'waiting', currentStep: 'checks', reason: HELD });
    await storeRun(runs(), part);
    const epic = (await runs().findRun(KEY))!;
    writeRunState(epic, {
      status: 'waiting',
      currentStep: 'implement',
      reason: { code: 'SUBTASK_WAITING', message: 'a subtask waits' },
    });
    await storeRun(runs(), epic);
    const head = landOnMain('src/fix.ts', 'export const fix = 1;\n');

    await backlogPass();
    expect(rebaseKeys()).toEqual([]);

    flow.host.defaultBranchPasses();
    await backlogPass();
    await settleAll();

    expect(isIn(flow.tree, head)).toBe(true);
    expect(isIn(treeOf('a'), head)).toBe(true);
    expect(rebaseKeys()[0]).toBe(KEY);
    expect(rebaseKeys()).toContain(childKey('a'));
    // The part does not keep its wait: the move resumes it on the tree that has main.
    expect(flow.launched).toContain(childKey('a'));
    expect(sent.every((command) => ['rebase', 'resume'].includes(command.type))).toBe(true);
  });

  it('holds an epic whose part question the backlog planner answered under a red main; the main move moves the part with its wait kept and the answer reaches it', async () => {
    await boot(new BlockAgentRunner({ plan: [{ block: { escalate: 'The owner must decide.' } }] }));
    await seedEpic([task('a')]);
    await ask('a');
    await kit.handUpQuestion();
    expect((await stateOf(KEY)).reason?.code).toBe('ASKS_PLANNER');
    const backlogs = flow.app.app.get(BacklogRepository);
    const [backlog] = await backlogs.listBacklogs();
    const [epicTask] = await backlogs.tasks(backlog.id as number);
    await backlogs.saveTask({ ...epicTask, id: undefined, slug: 'fix', runKey: null, fixesMain: 'demo', position: 2 });

    await flow.app.app
      .get(PlannerRunPort)
      .send({ type: 'answer', run: KEY, answers: [{ body: 'Ids are numbers.' }] }, 'ada', 'turn-1-action-0');
    await settleAll();

    expect(await stateOf(KEY)).toMatchObject({ state: 'waiting', reason: { code: REASON.waitsForMain } });
    expect(await kit.waitingKept('a')).toEqual({ state: 'waiting', step: 'research', started: false });
    expect(rebaseKeys()).toEqual([]);

    const head = landOnMain('src/fix.ts', 'export const fix = 1;\n');
    flow.host.defaultBranchPasses();
    await backlogPass();
    await settleAll();

    expect(rebaseKeys()[0]).toBe(KEY);
    expect(isIn(flow.tree, head)).toBe(true);
    expect(isIn(treeOf('a'), head)).toBe(true);
    expect(await documents().latestBody(childKey('a'), 'answers')).toContain('Ids are numbers.');
    expect(flow.launched).toContain(childKey('a'));
    // After the planner's answer nothing but the server's own commands reach the epic and its part.
    expect(sent.filter((command) => command.key.startsWith(KEY)).map((c) => `${c.type} ${c.key}`)).toEqual([
      `answer ${KEY}`,
      `rebase ${KEY}`,
      `rebase ${childKey('a')}`,
      `answer ${childKey('a')}`,
    ]);
    expect((await stateOf(KEY)).reason?.code).not.toBe(REASON.waitsForMain);
  });
});
