import type { BacklogTurnAction } from '../../../agent-result/definitions/backlog-turn';
import type { JudgedAction } from './planner-rules';
import { withPlanner } from './planner-scenarios.spec-helpers';

type Harness = Parameters<Parameters<typeof withPlanner>[0]>[0];

const task = { id: 'fix', title: 'Fix', description: 'D', repositories: ['web'] };

/** What the rules say about an action of the backlog `alpha`: its refusal, or null when it goes on. */
async function refusal(harness: Harness, action: JudgedAction): Promise<string | null> {
  const backlog = await harness.backlogs.findBacklog('alpha');
  const judged = await harness.rules.judge(harness.backlogs, backlog as NonNullable<typeof backlog>, action);
  return 'refusal' in judged ? judged.refusal : null;
}

describe('PlannerRules', () => {
  it('refuses what only the owner does', () =>
    withPlanner(async (harness) => {
      await harness.seed();
      for (const name of ['runMilestone', 'runBacklog', 'runTask', 'addRepository', 'mergeTask']) {
        expect(await refusal(harness, { action: name })).toContain('only the owner');
      }
      expect(await refusal(harness, { action: 'pause' })).toBeNull();
    }));

  it('refuses a task that names a repository outside the backlog and tells the planner to ask the person', () =>
    withPlanner(async (harness) => {
      await harness.seed(['web']);
      const outside = { action: 'addTasks', tasks: [{ ...task, repositories: ['elsewhere'] }] } as const;
      expect(await refusal(harness, outside)).toBe(
        'elsewhere is not a repository of this backlog: ask the person in the chat to add it to the backlog',
      );
      expect(await refusal(harness, { action: 'addTasks', tasks: [task] })).toBeNull();
    }));

  it('refuses a change of a started task and allows one that has not started', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });
      await harness.task(backlogId, null, 'later');
      for (const action of [
        { action: 'changeTask', task: 'going', revision: 0, description: 'new' },
        { action: 'deleteTask', task: 'going', revision: 0 },
        { action: 'moveItem', task: 'going', milestone: 1 },
      ] as BacklogTurnAction[]) {
        expect(await refusal(harness, action)).toContain('has started: skipBacklogTask skips it');
      }
      expect(await refusal(harness, { action: 'skipBacklogTask', task: 'going' })).toBeNull();
      expect(
        await refusal(harness, { action: 'changeTask', task: 'later', revision: 0, description: 'new' }),
      ).toBeNull();
    }));

  it('refuses a command to a run that is not one of the backlog', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });
      expect(await refusal(harness, { action: 'stop', run: 'other-1' })).toBe('other-1 is not a run of this backlog');
      expect(await refusal(harness, { action: 'stop', run: 'going-1' })).toBeNull();
    }));

  it('accepts every run command for a run below a task run, and refuses a run outside the backlog', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });
      await harness.run('going-1', { status: 'waiting' });
      const parent = await harness.runs.findRun('going-1');
      await harness.runs.openSubtask('going-1-a', (parent as NonNullable<typeof parent>).id, 'a');
      const answers = [{ body: 'yes' }];
      expect(await refusal(harness, { action: 'answerRun', run: 'going-1-a', answers })).toBeNull();
      expect(await refusal(harness, { action: 'passQuestion', run: 'going-1-a', reason: 'Yours.' })).toBeNull();
      const below = 'going-1-a';
      expect(await refusal(harness, { action: 'planChat', run: below, message: 'hi' })).toBeNull();
      expect(await refusal(harness, { action: 'resume', run: below })).toBeNull();
      expect(
        await refusal(harness, { action: 'replay', run: below, step: 'implement', instruction: 'Go.' }),
      ).toBeNull();
      expect(await refusal(harness, { action: 'rebase', run: below })).toBeNull();
      expect(await refusal(harness, { action: 'skipTask', run: below, task: 'a' })).toBeNull();
      expect(await refusal(harness, { action: 'stop', run: below })).toBeNull();
      expect(await refusal(harness, { action: 'answerRun', run: 'other-1', answers })).toBe(
        'other-1 is not a run of this backlog',
      );
    }));

  it('refuses a resume, a replay and a rebase of a run that ended the same way a third time on the same tree, and not on a new head', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });
      let count = 0;
      const ended = async (runKey: string, endRun: string, endHeads: string) => {
        count += 1;
        harness.clock.advance(1000);
        await harness.addEvent(backlogId, `needs-person:${runKey}:${count}`, 'run-needs-person', {
          runKey,
          endRun,
          endStep: 'implement',
          endCode: '',
          endHeads,
        });
      };
      const actions: JudgedAction[] = [
        { action: 'resume', run: 'going-1' },
        { action: 'replay', run: 'going-1', step: 'implement', instruction: 'Go.' },
        { action: 'rebase', run: 'going-1' },
      ];
      await ended('going-1', 'going-1', 'web=a1');
      await ended('going-1', 'going-1', 'web=a1');
      for (const action of actions) expect(await refusal(harness, action)).toBeNull();
      await ended('going-1', 'going-1', 'web=a1');
      for (const action of actions) {
        expect(await refusal(harness, action)).toBe(
          'going-1 ended the same way a third time on the same tree (implement, no reason code): stop it, leave its error as it is and report it in the chat',
        );
      }
      expect(await refusal(harness, { action: 'stop', run: 'going-1' })).toBeNull();
      await ended('going-1', 'going-1', 'web=b2');
      for (const action of actions) expect(await refusal(harness, action)).toBeNull();
    }));

  it('refuses a resume of an epic whose part ended the same way a third time on the same tree', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });
      for (const n of [1, 2, 3]) {
        harness.clock.advance(1000);
        await harness.addEvent(backlogId, `needs-person:going-1:${n}`, 'run-needs-person', {
          runKey: 'going-1',
          endRun: 'going-1-a',
          endStep: 'checks',
          endCode: 'CHECKS_FAILED',
          endHeads: 'web=a1',
        });
      }
      expect(await refusal(harness, { action: 'resume', run: 'going-1' })).toContain(
        'ended the same way a third time on the same tree (checks, CHECKS_FAILED)',
      );
    }));

  it('accepts a further task for a requirement after two covering tasks merged', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      for (const slug of ['first', 'second', 'third']) {
        await harness.task(backlogId, milestoneId, slug, { covers: ['M1.R1'], status: 'merged' });
      }
      const further = { action: 'addTasks', tasks: [{ ...task, id: 'more', covers: ['M1.R1'] }] } as const;
      expect(await refusal(harness, further)).toBeNull();
    }));

  it('refuses a second open fix of a repository', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      const fix = { action: 'addTasks', tasks: [{ ...task, id: 'again', fixesMain: 'web' }] } as const;
      expect(await refusal(harness, fix)).toBeNull();
      await harness.task(backlogId, milestoneId, 'fix-one', { fixesMain: 'web' });
      expect(await refusal(harness, fix)).toContain('a task already fixes the red main of web');
      expect(
        await refusal(harness, {
          action: 'addTasks',
          tasks: [{ ...task, id: 'srv', repositories: ['server'], fixesMain: 'server' }],
        }),
      ).toBeNull();

      await harness.backlogs.saveTask({ ...(await harness.tasks(backlogId))[0], status: 'merged' });
      await harness.task(backlogId, milestoneId, 'fix-two', { fixesMain: 'web', status: 'merged' });
      await harness.addEvent(backlogId, 'main-red:web:abc', 'main-red', { repository: 'web', head: 'abc' });
      expect(await refusal(harness, fix)).toBeNull();
    }));

  it('puts a fix without a milestone in the active milestone, and refuses it when none is active', () =>
    withPlanner(async (harness) => {
      await harness.seed();
      const backlog = (await harness.backlogs.findBacklog('alpha')) as NonNullable<
        Awaited<ReturnType<typeof harness.backlogs.findBacklog>>
      >;
      const judged = await harness.rules.judge(harness.backlogs, backlog, {
        action: 'addTasks',
        tasks: [{ ...task, fixesMain: 'web' }],
      });
      expect(judged).toMatchObject({ action: { tasks: [{ id: 'fix', milestone: 1 }] } });

      const [milestone] = await harness.backlogs.milestones(backlog.id as number);
      await harness.backlogs.saveMilestone({ ...milestone, status: 'accepted' });
      expect(await refusal(harness, { action: 'addTasks', tasks: [{ ...task, fixesMain: 'web' }] })).toContain(
        'no milestone is active',
      );
    }));
  it('passes an offer of a proposed milestone and of an idle task outside the active milestone', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.backlogs.saveMilestone({
        backlogId,
        number: 2,
        title: 'Next',
        goal: 'G',
        status: 'proposed',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      await harness.task(backlogId, null, 'idle');
      expect(await refusal(harness, { action: 'offerRun', milestone: 2 })).toBeNull();
      expect(await refusal(harness, { action: 'offerRun', task: 'idle' })).toBeNull();
    }));

  it('refuses an offer that names neither or both, or a start the owner could not take now', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      await harness.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });
      await harness.task(backlogId, null, 'dropped', { status: 'skipped' });
      await harness.task(backlogId, milestoneId, 'inside');
      expect(await refusal(harness, { action: 'offerRun' })).toContain('a milestone or a task');
      expect(await refusal(harness, { action: 'offerRun', milestone: 1, task: 'inside' })).toContain(
        'a milestone or a task',
      );
      expect(await refusal(harness, { action: 'offerRun', milestone: 1 })).toBe('M1 is not a proposed milestone');
      expect(await refusal(harness, { action: 'offerRun', milestone: 9 })).toBe('M9 is not a proposed milestone');
      expect(await refusal(harness, { action: 'offerRun', task: 'nothing' })).toBe(
        'nothing is not a task of this backlog',
      );
      expect(await refusal(harness, { action: 'offerRun', task: 'going' })).toBe('going has started');
      expect(await refusal(harness, { action: 'offerRun', task: 'dropped' })).toBe('dropped is skipped');
      expect(await refusal(harness, { action: 'offerRun', task: 'inside' })).toBe(
        'inside is in the active milestone and starts by itself',
      );
    }));
});
