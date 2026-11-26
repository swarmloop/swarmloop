import 'reflect-metadata';
import { REASON } from '../contract/reason-words';
import { writeRunState } from '../history/run-state';
import { bootEpicFlow, epicMainKit, KEY, requirements, task } from './flow-epic-main.spec-helpers';
import { checkDocker } from './check-docker.spec-helpers';
import { save } from './runs.spec-helpers';
import { storeRun } from './store-run.spec-helpers';
import { CommandService } from '../pipeline/command.service';

const HELD = { code: REASON.waitsForMain, message: 'waits for a green main of demo' };

describe('a run that waits for a green main is rebased and resumed once main is green', () => {
  let flow: Awaited<ReturnType<typeof bootEpicFlow>>;
  let sent: { type: string; key: string }[];
  const docker = checkDocker(() => 0);
  const kit = epicMainKit(() => flow);
  const { runs, documents, isIn, landOnMain, backlogPass, settleAll, stateOf, childKey, treeOf, seedEpic } = kit;

  const boot = async () => {
    sent = [];
    flow = await bootEpicFlow(sent, docker, undefined, undefined, false);
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
});
