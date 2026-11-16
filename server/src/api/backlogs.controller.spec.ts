import 'reflect-metadata';
import type { BacklogActions } from '../pipeline/backlog/backlog-actions';
import type { BacklogQueries } from '../pipeline/backlog/backlog-queries';
import { BacklogsController } from './backlogs.controller';

const VIEW = { name: 'shop' };

function controller() {
  const answer = jest.fn().mockResolvedValue(VIEW);
  const actions = {
    createBacklog: answer,
    runBacklog: answer,
    pause: answer,
    unpause: answer,
    addRepository: answer,
    recordDecision: answer,
    proposeMilestone: answer,
    runMilestone: answer,
    acceptMilestone: answer,
    addRequirements: answer,
    addTasks: answer,
    changeTask: answer,
    deleteTask: answer,
    skipTask: answer,
    mergeTask: answer,
    runTaskNow: answer,
    addItem: answer,
    moveItem: answer,
    dropItem: answer,
  };
  const queries = { list: jest.fn().mockResolvedValue([VIEW]), view: answer };
  return {
    answer,
    queries,
    controller: new BacklogsController(actions as unknown as BacklogActions, queries as unknown as BacklogQueries),
  };
}

describe('BacklogsController', () => {
  it('hands the actor and the body of each write route to the service and returns its answer', async () => {
    const { controller: routes, answer } = controller();
    const body = { text: 'x' } as never;
    const calls: [() => Promise<unknown>, unknown[]][] = [
      [() => routes.create('ada', body), ['ada', body]],
      [() => routes.run('ada', 'shop'), ['ada', 'shop']],
      [() => routes.pause('ada', 'shop'), ['ada', 'shop']],
      [() => routes.unpause('ada', 'shop'), ['ada', 'shop']],
      [() => routes.addRepository('ada', 'shop', body), ['ada', 'shop', body]],
      [() => routes.recordDecision('ada', 'shop', body), ['ada', 'shop', body]],
      [() => routes.proposeMilestone('ada', 'shop', body), ['ada', 'shop', body]],
      [() => routes.runMilestone('ada', 'shop', 2), ['ada', 'shop', 2]],
      [() => routes.acceptMilestone('ada', 'shop', 2), ['ada', 'shop', 2]],
      [() => routes.addRequirements('ada', 'shop', 2, body), ['ada', 'shop', 2, body]],
      [() => routes.addTasks('ada', 'shop', body), ['ada', 'shop', body]],
      [() => routes.changeTask('ada', 'shop', 'one', body), ['ada', 'shop', 'one', body]],
      [() => routes.deleteTask('ada', 'shop', 'one'), ['ada', 'shop', 'one']],
      [() => routes.skipTask('ada', 'shop', 'one'), ['ada', 'shop', 'one']],
      [() => routes.mergeTask('ada', 'shop', 'one'), ['ada', 'shop', 'one']],
      [() => routes.runTaskNow('ada', 'shop', 'one'), ['ada', 'shop', 'one']],
      [() => routes.addItem('ada', 'shop', body), ['ada', 'shop', body]],
      [() => routes.moveItem('ada', 'shop', 'one', body), ['ada', 'shop', 'one', body]],
      [() => routes.dropItem('ada', 'shop', 'one'), ['ada', 'shop', 'one']],
    ];
    for (const [call, args] of calls) {
      answer.mockClear();
      expect(await call()).toBe(VIEW);
      expect(answer).toHaveBeenCalledWith(...args);
    }
  });

  it('answers the reads from the queries', async () => {
    const { controller: routes, queries } = controller();
    expect(await routes.list()).toEqual([VIEW]);
    expect(await routes.view('shop')).toBe(VIEW);
    expect(queries.view).toHaveBeenCalledWith('shop');
  });
});
