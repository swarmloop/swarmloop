import { ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { actionsHarness } from './backlog.spec-helpers';

async function withActions(body: (harness: Awaited<ReturnType<typeof actionsHarness>>) => Promise<void>) {
  const harness = await actionsHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

const NEW = { name: 'shop', repositories: ['web'], mergeMode: 'green' as const };

/** A backlog of `ada` with `count` proposed milestones. */
async function withMilestones(harness: Awaited<ReturnType<typeof actionsHarness>>, count: number) {
  await harness.actions.createBacklog('ada', NEW);
  for (let index = 1; index <= count; index += 1) {
    await harness.actions.proposeMilestone('ada', 'shop', { title: `Part ${index}`, goal: 'Goal' });
  }
}

const statuses = async (harness: Awaited<ReturnType<typeof actionsHarness>>) =>
  (await harness.queries.view('shop')).milestones.map((milestone) => milestone.status);

describe('BacklogActions', () => {
  it('makes a backlog owned by the actor and shows it in the view and the list', () =>
    withActions(async (harness) => {
      const view = await harness.actions.createBacklog('ada', { ...NEW, repositories: ['web', 'server'] });
      expect(view).toMatchObject({ name: 'shop', owner: 'ada', repositories: ['web', 'server'], paused: false });
      expect((await harness.queries.list()).map((backlog) => backlog.name)).toEqual(['shop']);
      await expect(harness.queries.view('none')).rejects.toThrow(NotFoundException);
    }));

  it('queues the proposed milestones behind the one it runs and starts each when the one before is accepted', () =>
    withActions(async (harness) => {
      await withMilestones(harness, 3);
      await harness.actions.runBacklog('ada', 'shop');
      expect(await statuses(harness)).toEqual(['active', 'queued', 'queued']);

      await harness.actions.proposeMilestone('ada', 'shop', { title: 'Later', goal: '' });
      expect(await statuses(harness)).toEqual(['active', 'queued', 'queued', 'proposed']);

      await harness.actions.acceptMilestone('ada', 'shop', 1);
      expect(await statuses(harness)).toEqual(['accepted', 'active', 'queued', 'proposed']);
      await harness.actions.acceptMilestone('ada', 'shop', 2);
      await harness.actions.acceptMilestone('ada', 'shop', 3);
      expect(await statuses(harness)).toEqual(['accepted', 'accepted', 'accepted', 'proposed']);
    }));

  it('runs one milestone alone and leaves the others proposed', () =>
    withActions(async (harness) => {
      await withMilestones(harness, 2);
      await harness.actions.runMilestone('ada', 'shop', 2);
      expect(await statuses(harness)).toEqual(['proposed', 'active']);
      await expect(harness.actions.runMilestone('ada', 'shop', 2)).rejects.toThrow(ConflictException);
    }));

  it('refuses the owner-only actions to another login and writes nothing', () =>
    withActions(async (harness) => {
      await withMilestones(harness, 1);
      const before = await harness.actionEvents('shop');
      for (const act of [
        () => harness.actions.runBacklog('bob', 'shop'),
        () => harness.actions.runMilestone('bob', 'shop', 1),
        () => harness.actions.addRepository('bob', 'shop', { repository: 'server' }),
        () => harness.actions.acceptMilestone('bob', 'shop', 1),
      ]) {
        await expect(act()).rejects.toThrow(ForbiddenException);
      }
      expect(await statuses(harness)).toEqual(['proposed']);
      expect((await harness.queries.view('shop')).repositories).toEqual(['web']);
      expect(await harness.actionEvents('shop')).toEqual(before);
    }));

  it('refuses a call with nobody logged in', () =>
    withActions(async (harness) => {
      await expect(harness.actions.createBacklog(null, NEW)).rejects.toThrow(UnauthorizedException);
      expect(await harness.queries.list()).toEqual([]);
    }));

  it('refuses a bad name, scope, mode and status and writes nothing', () =>
    withActions(async (harness) => {
      await expect(harness.actions.createBacklog('ada', { ...NEW, name: 'a b' })).rejects.toThrow('backlog name');
      await expect(harness.actions.createBacklog('ada', { ...NEW, repositories: ['elsewhere'] })).rejects.toThrow(
        'not a checkout project',
      );
      await expect(harness.actions.createBacklog('ada', { ...NEW, mergeMode: 'yolo' as never })).rejects.toThrow(
        'merge mode',
      );
      expect(await harness.queries.list()).toEqual([]);

      await withMilestones(harness, 1);
      await expect(harness.actions.createBacklog('ada', NEW)).rejects.toThrow(ConflictException);
      await expect(harness.actions.acceptMilestone('ada', 'shop', 1)).rejects.toThrow(ConflictException);
      await expect(harness.actions.addRepository('ada', 'shop', { repository: 'elsewhere' })).rejects.toThrow(
        'not a checkout project',
      );
      await expect(harness.actions.addRepository('ada', 'shop', { repository: 'web' })).rejects.toThrow(
        ConflictException,
      );
      await expect(harness.actions.addRequirements('ada', 'shop', 1, { texts: ['  '] })).rejects.toThrow('empty');
      await expect(harness.actions.addRequirements('ada', 'shop', 9, { texts: ['x'] })).rejects.toThrow(
        NotFoundException,
      );
      const view = await harness.queries.view('shop');
      expect(view.milestones.map((milestone) => milestone.status)).toEqual(['proposed']);
      expect(view.requirements).toEqual([]);
      expect(view.repositories).toEqual(['web']);
    }));

  it('adds requirements as open with the next refs and adds a repository to the scope', () =>
    withActions(async (harness) => {
      await withMilestones(harness, 1);
      await harness.actions.addRequirements('bob', 'shop', 1, { texts: ['First', 'Second'] });
      const view = await harness.actions.addRequirements('ada', 'shop', 1, { texts: ['Third'] });
      expect(view.requirements.map((requirement) => [requirement.ref, requirement.status])).toEqual([
        ['M1.R1', 'open'],
        ['M1.R2', 'open'],
        ['M1.R3', 'open'],
      ]);
      expect((await harness.actions.addRepository('ada', 'shop', { repository: 'server' })).repositories).toEqual([
        'web',
        'server',
      ]);
    }));

  it('pauses and unpauses and records a decision with text, who and time', () =>
    withActions(async (harness) => {
      await harness.actions.createBacklog('ada', NEW);
      expect((await harness.actions.pause('bob', 'shop')).paused).toBe(true);
      expect((await harness.actions.unpause('bob', 'shop')).paused).toBe(false);
      const view = await harness.actions.recordDecision('bob', 'shop', { text: ' Use SQLite ' });
      expect(view.decisions).toEqual([{ text: 'Use SQLite', who: 'bob', at: expect.any(String) }]);
    }));

  it('records every action with who did it and when', () =>
    withActions(async (harness) => {
      await withMilestones(harness, 1);
      await harness.actions.addRequirements('bob', 'shop', 1, { texts: ['x'] });
      await harness.actions.pause('bob', 'shop');
      await harness.actions.unpause('ada', 'shop');
      await harness.actions.recordDecision('ada', 'shop', { text: 'd' });
      await harness.actions.addRepository('ada', 'shop', { repository: 'server' });
      await harness.actions.runMilestone('ada', 'shop', 1);
      await harness.actions.acceptMilestone('ada', 'shop', 1);
      const events = await harness.actionEvents('shop');
      expect(events.map((event) => [event.facts.action, event.facts.who])).toEqual([
        ['create backlog', 'ada'],
        ['propose milestone', 'ada'],
        ['add requirements', 'bob'],
        ['pause', 'bob'],
        ['unpause', 'ada'],
        ['record decision', 'ada'],
        ['add repository', 'ada'],
        ['run milestone', 'ada'],
        ['accept milestone', 'ada'],
      ]);
      for (const event of events) expect(event.facts.at).toBe(event.createdAt);
    }));

  it('shows the events of a backlog in its view', () =>
    withActions(async (harness) => {
      await withMilestones(harness, 1);
      const view = await harness.queries.view('shop');
      expect(view.events.map((event) => event.kind)).toEqual(['action', 'action']);
      expect(view.milestones).toEqual([{ number: 1, title: 'Part 1', goal: 'Goal', status: 'proposed' }]);
    }));
});
