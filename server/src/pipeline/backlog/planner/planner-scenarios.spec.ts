import { turnResult, withPlanner } from './planner-scenarios.spec-helpers';

const task = (id: string, extra: object = {}) => ({
  id,
  title: id,
  description: `Today: nothing.\nDo ${id}.`,
  repositories: ['web'],
  milestone: 1,
  ...extra,
});

describe('planner scenarios: scripted turn results', () => {
  it('carries the milestone it proposes in the message, and starts nothing before the owner runs it', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult(
          'I propose M2: search. Run it?',
          { action: 'proposeMilestone', title: 'Search', goal: 'Find things' },
          { action: 'addRequirements', milestone: 2, texts: ['A person finds an item'] },
          { action: 'addTasks', tasks: [task('search', { milestone: 2, covers: ['M2.R1'] })] },
        ),
      );
      const { messages } = await harness.chat.lastMessages(backlogId, 10);
      expect(messages.map((message) => [message.text, message.proposes])).toEqual([
        ['I propose M2: search. Run it?', true],
      ]);
      const milestones = await harness.backlogs.milestones(backlogId);
      expect(milestones.map((milestone) => [milestone.number, milestone.status])).toEqual([
        [1, 'active'],
        [2, 'proposed'],
      ]);
      const [added] = await harness.tasks(backlogId);
      expect([added.slug, added.status, added.runKey]).toEqual(['search', 'waiting', null]);
      expect(harness.sent).toEqual([]);
    }));

  it('answers a run question that the milestone answers with answer', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      await harness.task(backlogId, milestoneId, 'going', { runKey: 'going-1', status: 'running' });
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult('', { action: 'answerRun', run: 'going-1', answers: [{ id: 'q1', body: 'Yes: M1.R1 says so' }] }),
      );
      expect(harness.sent).toEqual([
        {
          command: { type: 'answer', run: 'going-1', answers: [{ id: 'q1', body: 'Yes: M1.R1 says so' }] },
          owner: 'owner',
          key: 'turn-1-action-0',
        },
      ]);
      expect(await harness.lines(backlogId)).toEqual([]);
    }));

  it('answers a technical question with its reason as an info line and a decision', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      await harness.task(backlogId, milestoneId, 'going', { runKey: 'going-1', status: 'running' });
      const reason = 'M1.R2 needs the parser library, so the brief allows it';
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult('', {
          action: 'answerRun',
          run: 'going-1',
          answers: [{ body: 'Add the parser library' }],
          reason,
        }),
      );
      expect(await harness.lines(backlogId)).toEqual([reason]);
      expect((await harness.backlogs.decisions(backlogId)).map((decision) => decision.text)).toEqual([reason]);
      expect(harness.sent.map(({ command }) => command.type)).toEqual(['answer']);
    }));

  it('turns a question it cannot answer into a chat question and sends nothing, so the run keeps waiting', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      await harness.task(backlogId, milestoneId, 'going', { runKey: 'going-1', status: 'running' });
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult('The run asks whether guests may see prices. That is a product decision: what do you want?'),
      );
      expect(await harness.lines(backlogId)).toEqual([
        'The run asks whether guests may see prices. That is a product decision: what do you want?',
      ]);
      expect(harness.sent).toEqual([]);
    }));

  it('closes the requirement of a merged task with evidence, or adds a fix task for what is missing', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      await harness.task(backlogId, milestoneId, 'done', { covers: ['M1.R1', 'M1.R2'], status: 'merged' });
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult(
          'M1.R1 is met; M1.R2 is only half done, so I add a fix.',
          { action: 'closeRequirement', id: 'M1.R1', evidence: 'The report lists the route and main has it' },
          { action: 'addTasks', tasks: [task('finish-r2', { covers: ['M1.R2'] })] },
        ),
      );
      const statuses = (await harness.backlogs.requirements(backlogId)).map((requirement) => requirement.status);
      expect(statuses).toEqual(['closed', 'open']);
      const facts = await harness.actionFacts(backlogId);
      expect(facts.find((fact) => fact.action === 'close requirement')).toMatchObject({
        evidence: 'The report lists the route and main has it',
        via: 'the planner',
      });
      expect((await harness.tasks(backlogId)).map((record) => record.slug)).toEqual(['done', 'finish-r2']);
    }));

  it('updates the Today of a task that has not started after a merge, and drops one the merge made unnecessary with its reason', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      await harness.task(backlogId, milestoneId, 'moved', { description: 'Today: it is in old/path.ts.' });
      await harness.task(backlogId, milestoneId, 'extra', { description: 'Add the helper.' });
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult(
          'The merge moved old/path.ts to new/path.ts, so I updated moved. extra is unnecessary: the merge added the helper.',
          {
            action: 'changeTask',
            task: 'moved',
            description: 'Today: it is in new/path.ts.',
            reason: 'The file moved',
          },
          { action: 'deleteTask', task: 'extra', reason: 'The merged task added the helper' },
        ),
      );
      const records = await harness.tasks(backlogId);
      expect(records.map((record) => [record.slug, record.description])).toEqual([
        ['moved', 'Today: it is in new/path.ts.'],
      ]);
      expect((await harness.lines(backlogId))[0]).toContain('extra is unnecessary');
    }));

  it('sends two fixes of a red main in a row to the person', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      await harness.addEvent(backlogId, 'main-red:web:a1', 'main-red', { repository: 'web', head: 'a1' });
      await harness.task(backlogId, milestoneId, 'fix-one', { fixesMain: 'web', status: 'merged' });
      await harness.task(backlogId, milestoneId, 'fix-two', { fixesMain: 'web', status: 'merged' });
      const third = turnResult('Main is still red; here is another fix.', {
        action: 'addTasks',
        tasks: [task('fix-three', { fixesMain: 'web' })],
      });
      expect(await harness.turns.check('alpha', third)).toEqual([
        'add fix-three: two fixes of web merged and its main is still red: ask the person in the chat',
      ]);
      await harness.turns.apply('alpha', 'turn-1', third);
      expect((await harness.tasks(backlogId)).map((record) => record.slug)).toEqual(['fix-one', 'fix-two']);
      expect((await harness.lines(backlogId))[1]).toContain('ask the person in the chat');
    }));

  it('gives a red main one fix task, first in the active milestone, and refuses a second while it is open', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      await harness.addEvent(backlogId, 'main-red:web:a1', 'main-red', { repository: 'web', head: 'a1' });
      await harness.task(backlogId, milestoneId, 'planned');
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult('Main is red: one fix goes first.', {
          action: 'addTasks',
          tasks: [
            { id: 'fix-main', title: 'Fix main', description: 'Fix it.', repositories: ['web'], fixesMain: 'web' },
          ],
        }),
      );
      const records = await harness.tasks(backlogId);
      expect(records.map((record) => record.slug)).toEqual(['fix-main', 'planned']);
      expect(records[0]).toMatchObject({ milestoneId, fixesMain: 'web' });
      const again = turnResult('', { action: 'addTasks', tasks: [task('fix-main-2', { fixesMain: 'web' })] });
      expect(await harness.turns.check('alpha', again)).toEqual([
        'add fix-main-2: a task already fixes the red main of web: fix-main-2 waits for it',
      ]);
    }));

  it('refuses a second resume of a run for the same reason and leaves the question to the person', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      await harness.task(backlogId, milestoneId, 'going', { runKey: 'going-1', status: 'running' });
      await harness.run('going-1', { status: 'blocked', facts: { blockCode: 'loop-limit' } });
      const resume = turnResult('Trying again.', { action: 'resume', run: 'going-1' });
      await harness.turns.apply('alpha', 'turn-1', resume);
      expect(harness.sent.map(({ key }) => key)).toEqual(['turn-1-action-0']);

      await harness.run('going-1', { status: 'blocked', facts: { blockCode: 'loop-limit' } });
      await harness.turns.apply('alpha', 'turn-2', resume);
      expect(harness.sent).toHaveLength(1);
      expect((await harness.lines(backlogId)).pop()).toBe(
        'I did not resume going-1: going-1 is blocked again for the same reason as at the last resume: ask the person in the chat',
      );
    }));

  it('refuses a repository outside the scope with the ask to the person', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed(['web']);
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult('The change needs the docs repository.', {
          action: 'addTasks',
          tasks: [task('docs', { repositories: ['docs'] })],
        }),
      );
      expect(await harness.tasks(backlogId)).toEqual([]);
      expect((await harness.lines(backlogId))[1]).toBe(
        'I did not add docs: docs is not a repository of this backlog: ask the person in the chat to add it to the backlog',
      );
    }));

  it('gives two queued tasks on the same skill text one owner, and the other builds on it', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      await harness.task(backlogId, milestoneId, 'skill-a', {
        description: 'Today: skill text.\nDo A.',
        files: ['skill.md'],
      });
      await harness.task(backlogId, milestoneId, 'skill-b', { description: 'Today: skill text.\nDo B.' });
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult('skill-a and skill-b both change the skill text, so skill-a owns it.', {
          action: 'changeTask',
          task: 'skill-b',
          description: 'Today: skill-a rewrites the skill text; build on it.\nDo B.',
          depends: ['skill-a'],
        }),
      );
      const records = await harness.tasks(backlogId);
      expect(records.map((record) => [record.slug, record.depends])).toEqual([
        ['skill-a', []],
        ['skill-b', ['skill-a']],
      ]);
      expect(records[1].description).toContain('skill-a rewrites the skill text');
    }));

  it('sends a clash with a running epic to its planner by planChat and never writes into the epic', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      await harness.task(backlogId, milestoneId, 'epic', {
        runKey: 'epic-1',
        status: 'running',
        description: 'The epic brief.',
      });
      const turn = turnResult(
        'The queued task renames the step that a subtask of the epic names; I told the epic.',
        { action: 'planChat', run: 'epic-1', message: 'The step was renamed: subtask two must follow the new name.' },
        { action: 'changeTask', task: 'epic', description: 'Rewritten by the backlog planner' },
      );
      await harness.turns.apply('alpha', 'turn-1', turn);
      expect(harness.sent).toEqual([
        {
          command: {
            type: 'planChat',
            run: 'epic-1',
            message: 'The step was renamed: subtask two must follow the new name.',
          },
          owner: 'owner',
          key: 'turn-1-action-0',
        },
      ]);
      expect((await harness.tasks(backlogId))[0].description).toBe('The epic brief.');
    }));

  it('lets a task take a later task rule into its own Do before it starts, and the later task keeps it', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      await harness.task(backlogId, milestoneId, 'first', { description: 'Do the first.' });
      await harness.task(backlogId, milestoneId, 'later', { description: 'Do the later.\nRule: close the gap.' });
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult('first leaves a gap that the rule of later closes, so first takes the rule.', {
          action: 'changeTask',
          task: 'first',
          description: 'Do the first.\nRule: close the gap.',
        }),
      );
      const records = await harness.tasks(backlogId);
      expect(records.map((record) => record.description)).toEqual([
        'Do the first.\nRule: close the gap.',
        'Do the later.\nRule: close the gap.',
      ]);
    }));

  it('refuses a change of a started task and lets planChat through', () =>
    withPlanner(async (harness) => {
      const { backlogId, milestoneId } = await harness.seed();
      await harness.task(backlogId, milestoneId, 'going', {
        runKey: 'going-1',
        status: 'running',
        description: 'Old.',
      });
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult(
          '',
          { action: 'changeTask', task: 'going', description: 'New.' },
          { action: 'planChat', run: 'going-1', message: 'The brief changed: do New.' },
        ),
      );
      expect((await harness.tasks(backlogId))[0].description).toBe('Old.');
      expect((await harness.lines(backlogId))[0]).toContain('I did not change going: going has started');
      expect(harness.sent.map(({ command }) => command.type)).toEqual(['planChat']);
    }));

  it('names a refused action once in the follow-up and then drops it with a chat line', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      const turn = turnResult('Added.', { action: 'moveItem', task: 'nowhere', milestone: 1 });
      expect(await harness.turns.check('alpha', turn)).toEqual(['move nowhere to milestone M1: no task nowhere']);
      await harness.turns.apply('alpha', 'turn-1', turn);
      expect(await harness.lines(backlogId)).toEqual([
        'Added.',
        'I did not move nowhere to milestone M1: no task nowhere',
      ]);
    }));
});
