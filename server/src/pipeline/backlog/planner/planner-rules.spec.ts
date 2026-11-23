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
        { action: 'changeTask', task: 'going', description: 'new' },
        { action: 'deleteTask', task: 'going' },
        { action: 'skipBacklogTask', task: 'going' },
        { action: 'moveItem', task: 'going', milestone: 1 },
      ] as BacklogTurnAction[]) {
        expect(await refusal(harness, action)).toContain('has started: write to its run with planChat');
      }
      expect(await refusal(harness, { action: 'changeTask', task: 'later', description: 'new' })).toBeNull();
    }));

  it('refuses a command to a run that is not one of the backlog', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });
      expect(await refusal(harness, { action: 'stop', run: 'other-1' })).toBe('other-1 is not a run of this backlog');
      expect(await refusal(harness, { action: 'stop', run: 'going-1' })).toBeNull();
    }));

  it('accepts an answer and a pass-on for a run below a task run, which holds a subtask question, but no other command', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });
      await harness.run('going-1', { status: 'waiting' });
      const parent = await harness.runs.findRun('going-1');
      await harness.runs.openSubtask('going-1-a', (parent as NonNullable<typeof parent>).id, 'a');
      const answers = [{ body: 'yes' }];
      expect(await refusal(harness, { action: 'answerRun', run: 'going-1-a', answers })).toBeNull();
      expect(await refusal(harness, { action: 'passQuestion', run: 'going-1-a', reason: 'Yours.' })).toBeNull();
      expect(await refusal(harness, { action: 'stop', run: 'going-1-a' })).toBe(
        'going-1-a is not a run of this backlog',
      );
      expect(await refusal(harness, { action: 'answerRun', run: 'other-1', answers })).toBe(
        'other-1 is not a run of this backlog',
      );
    }));

  it('refuses a resume of a run that is blocked again for the reason of its last planner resume', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });
      await harness.run('going-1', { status: 'blocked', reason: { code: 'loop-limit', message: 'loop-limit' } });
      expect(await refusal(harness, { action: 'resume', run: 'going-1' })).toBeNull();
      await harness.addEvent(backlogId, 'action:1', 'action', {
        command: 'resume',
        run: 'going-1',
        blockCode: 'loop-limit',
      });
      expect(await refusal(harness, { action: 'resume', run: 'going-1' })).toContain(
        'blocked again for the same reason',
      );
      await harness.run('going-1', { status: 'blocked', reason: { code: 'check-failed', message: 'check-failed' } });
      expect(await refusal(harness, { action: 'resume', run: 'going-1' })).toBeNull();
    }));

  it('refuses a further task for a requirement that is open after two covering tasks merged following its first', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      const covering = (slug: string, status: 'merged' | 'waiting') =>
        harness.task(backlogId, milestoneId, slug, { covers: ['M1.R1'], status });
      await covering('first', 'merged');
      await covering('second', 'merged');
      const further = { action: 'addTasks', tasks: [{ ...task, id: 'more', covers: ['M1.R1'] }] } as const;
      expect(await refusal(harness, further)).toBeNull();
      await covering('third', 'merged');
      expect(await refusal(harness, further)).toContain('M1.R1 is still open after two more tasks merged');
      expect(
        await refusal(harness, { action: 'addTasks', tasks: [{ ...task, id: 'other', covers: ['M1.R2'] }] }),
      ).toBeNull();
    }));

  it('refuses a second open fix of a repository, and a third after two merged on a main that is still red', () =>
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
      expect(await refusal(harness, fix)).toContain('two fixes of web merged and its main is still red');
      harness.clock.advance(1000);
      await harness.addEvent(backlogId, 'main-green:web:def', 'main-green', { repository: 'web', head: 'def' });
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
});
