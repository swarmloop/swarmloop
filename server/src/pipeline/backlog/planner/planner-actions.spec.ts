import { ConflictException } from '@nestjs/common';
import { turnResult, withPlanner } from './planner-scenarios.spec-helpers';

describe('PlannerTurnActions', () => {
  it('lands each backlog action through the service, recorded as the planner in the turn', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult(
          'Done.',
          { action: 'proposeMilestone', title: 'Second', goal: 'More' },
          { action: 'addRequirements', milestone: 1, texts: ['third'] },
          { action: 'recordDecision', text: 'Use the helper' },
          {
            action: 'addTasks',
            tasks: [{ id: 'one', title: 'One', description: 'D', repositories: ['web'], milestone: 1 }],
          },
          { action: 'addItem', id: 'item', title: 'Item', description: 'D' },
          { action: 'closeRequirement', id: 'M1.R1', evidence: 'on main' },
          { action: 'pause' },
        ),
      );
      const facts = await harness.actionFacts(backlogId);
      expect(facts.map((fact) => [fact.action, fact.via, fact.turn, fact.who])).toEqual([
        ['propose milestone', 'the planner', 'turn-1', 'owner'],
        ['add requirements', 'the planner', 'turn-1', 'owner'],
        ['record decision', 'the planner', 'turn-1', 'owner'],
        ['add tasks', 'the planner', 'turn-1', 'owner'],
        ['add item', 'the planner', 'turn-1', 'owner'],
        ['close requirement', 'the planner', 'turn-1', 'owner'],
        ['pause', 'the planner', 'turn-1', 'owner'],
      ]);
      expect((await harness.tasks(backlogId)).map((task) => task.slug)).toEqual(['one', 'item']);
      const requirements = await harness.backlogs.requirements(backlogId);
      expect(requirements.map((requirement) => [requirement.ref, requirement.status])).toContainEqual([
        'M1.R1',
        'closed',
      ]);
      expect((await harness.chat.findTurn('turn-1'))?.status).toBe('done');
    }));

  it('writes the say message with proposes when the turn proposed a milestone, and not otherwise', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult('I propose M2. Run it?', { action: 'proposeMilestone', title: 'Second', goal: 'G' }),
      );
      await harness.turns.apply('alpha', 'turn-2', turnResult('Nothing to change.'));
      const { messages } = await harness.chat.lastMessages(backlogId, 10);
      expect(messages.map((message) => [message.author, message.text, message.proposes, message.turn])).toEqual([
        ['planner', 'I propose M2. Run it?', true, 'turn-1'],
        ['planner', 'Nothing to change.', false, 'turn-2'],
      ]);
      expect((await harness.backlogs.milestones(backlogId)).map((milestone) => milestone.status)).toEqual([
        'active',
        'proposed',
      ]);
    }));

  it('writes nothing of a turn when one of its actions fails for a reason that is not a refusal', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      const run = harness.calls.run.bind(harness.calls);
      jest.spyOn(harness.calls, 'run').mockImplementation(async (call, action) => {
        if (action.action === 'pause') throw new Error('the disk is full');
        return run(call, action);
      });
      await expect(
        harness.turns.apply(
          'alpha',
          'turn-1',
          turnResult('Said.', { action: 'recordDecision', text: 'd' }, { action: 'pause' }),
        ),
      ).rejects.toThrow('the disk is full');
      expect(await harness.backlogs.decisions(backlogId)).toEqual([]);
      expect(await harness.lines(backlogId)).toEqual([]);
      expect(await harness.chat.findTurn('turn-1')).toBeNull();
    }));

  it('sends the run commands after the write with the key of their place, and a rerun resends them and writes nothing twice', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });
      const result = turnResult(
        'Answered.',
        { action: 'recordDecision', text: 'd' },
        { action: 'answerRun', run: 'going-1', answers: [{ body: 'yes' }] },
        { action: 'planChat', run: 'going-1', message: 'use the helper' },
      );
      harness.failNext(new Error('the server is restarting'));
      await expect(harness.turns.apply('alpha', 'turn-1', result)).rejects.toThrow('restarting');
      expect((await harness.chat.findTurn('turn-1'))?.status).toBe('applied');
      expect(harness.sent).toEqual([]);

      await harness.turns.apply('alpha', 'turn-1', result);
      expect(harness.sent.map(({ command, owner, key }) => [command.type, owner, key])).toEqual([
        ['answer', 'owner', 'turn-1-action-1'],
        ['planChat', 'owner', 'turn-1-action-2'],
      ]);
      expect((await harness.chat.findTurn('turn-1'))?.status).toBe('done');
      expect(await harness.backlogs.decisions(backlogId)).toHaveLength(1);
      expect(await harness.lines(backlogId)).toEqual(['Answered.']);
      expect((await harness.actionFacts(backlogId)).filter((fact) => fact.turn === 'turn-1')).toHaveLength(3);

      await harness.turns.apply('alpha', 'turn-1', result);
      expect(harness.sent).toHaveLength(2);
    }));

  it('names a refused action once in check, and drops it with a chat line in apply, the other actions going on', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed(['web']);
      const result = turnResult(
        'Planned.',
        {
          action: 'addTasks',
          tasks: [{ id: 'far', title: 'F', description: 'D', repositories: ['elsewhere'], milestone: 1 }],
        },
        { action: 'closeRequirement', id: 'M1.R9', evidence: 'x' },
        { action: 'recordDecision', text: 'kept' },
      );
      const named = await harness.turns.check('alpha', result);
      expect(named).toEqual([
        'add far: elsewhere is not a repository of this backlog: ask the person in the chat to add it to the backlog',
        'close M1.R9: no requirement M1.R9',
      ]);
      expect(await harness.backlogs.decisions(backlogId)).toEqual([]);
      expect(await harness.lines(backlogId)).toEqual([]);
      expect(await harness.chat.findTurn('check')).toBeNull();

      await harness.turns.apply('alpha', 'turn-1', result);
      expect(await harness.lines(backlogId)).toEqual(['Planned.', `I did not ${named[0]}`, `I did not ${named[1]}`]);
      expect((await harness.backlogs.decisions(backlogId)).map((decision) => decision.text)).toEqual(['kept']);
      expect(await harness.turns.check('alpha', turnResult('Fine.'))).toEqual([]);
    }));

  it('turns a refusal of b01 into a plain reason and a command that a run refuses into a chat line', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });
      harness.failNext(new ConflictException('going-1 is not waiting for an answer'));
      await harness.turns.apply(
        'alpha',
        'turn-1',
        turnResult('', { action: 'acceptMilestone', milestone: 7 }, { action: 'stop', run: 'going-1' }),
      );
      expect(await harness.lines(backlogId)).toEqual([
        'I did not accept milestone M7: no milestone M7',
        'going-1 refused the command: going-1 is not waiting for an answer',
      ]);
      expect((await harness.chat.findTurn('turn-1'))?.status).toBe('done');
    }));
});
