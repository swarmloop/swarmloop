import { ConflictException } from '@nestjs/common';
import { turnResult, withPlanner } from './planner-scenarios.spec-helpers';

const stop = turnResult('Stopping.', { action: 'stop', run: 'going-1' });

describe('a command a run refuses', () => {
  it('comes back to the planner once, and a repeat for the same reason is left to the person', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });

      harness.failNext(new ConflictException('going-1 is not running'));
      await harness.turns.apply('alpha', 'turn-1', stop);
      const refused = (await harness.backlogs.events(backlogId, 100)).filter(
        (event) => event.kind === 'command-refused',
      );
      expect(refused.map((event) => event.facts)).toEqual([
        { run: 'going-1', refusedCommand: 'stop going-1', reason: 'going-1 is not running' },
      ]);
      expect(await harness.chat.backlogsWithWaitingWork()).toEqual([backlogId]);

      const taken = await harness.chat.takeInto(backlogId, 'turn-2');
      expect(taken.events.map((event) => event.facts.reason)).toEqual(['going-1 is not running']);
      harness.failNext(new ConflictException('going-1 is not running'));
      await harness.turns.apply('alpha', 'turn-2', stop);
      const after = (await harness.backlogs.events(backlogId, 100)).filter((event) => event.kind === 'command-refused');
      expect(after).toHaveLength(1);
      expect(await harness.chat.backlogsWithWaitingWork()).toEqual([]);
      expect((await harness.lines(backlogId)).slice(-1)).toEqual(['I did not stop going-1: going-1 is not running']);
    }));

  it('starts a new turn when the run refuses it again for another reason', () =>
    withPlanner(async (harness) => {
      const { backlogId } = await harness.seed();
      await harness.task(backlogId, null, 'going', { runKey: 'going-1', status: 'running' });

      harness.failNext(new ConflictException('going-1 is not running'));
      await harness.turns.apply('alpha', 'turn-1', stop);
      await harness.chat.takeInto(backlogId, 'turn-2');
      harness.failNext(new ConflictException('going-1 is locked'));
      await harness.turns.apply('alpha', 'turn-2', stop);

      const refused = (await harness.backlogs.events(backlogId, 100)).filter(
        (event) => event.kind === 'command-refused',
      );
      expect(refused.map((event) => event.facts.reason).sort()).toEqual([
        'going-1 is locked',
        'going-1 is not running',
      ]);
      expect(await harness.chat.backlogsWithWaitingWork()).toEqual([backlogId]);
    }));
});
