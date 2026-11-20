import 'reflect-metadata';
import type { BacklogActions } from '../pipeline/backlog/backlog-actions';
import type { BacklogRepository } from '../history/backlog.repository';
import { BacklogQueries } from '../pipeline/backlog/backlog-queries';
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
    closeRequirement: answer,
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
      [() => routes.closeRequirement('ada', 'shop', 'M1.R1', body), ['ada', 'shop', 'M1.R1', body]],
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

type Row = Record<string, unknown>;

function queriesOver(mergeMode: 'green' | 'ok', requirements: Row[], tasks: Row[]): BacklogQueries {
  const backlog = { id: 1, name: 'shop', owner: 'ada', repositories: ['r'], mergeMode, paused: false };
  const repository = {
    listBacklogs: async () => [backlog],
    findBacklog: async () => backlog,
    milestones: async () => [{ id: 10, number: 3, title: 'T', goal: 'G', status: 'active' }],
    requirements: async () => requirements,
    tasks: async () => tasks,
    decisions: async () => [],
    events: async () => [],
  };
  return new BacklogQueries(repository as unknown as BacklogRepository);
}

const requirement = (ref: string, status: string): Row => ({ ref, milestoneId: 10, text: ref, status });
const task = (slug: string, overrides: Row = {}): Row => ({
  slug,
  title: slug,
  description: `about ${slug}`,
  milestoneId: 10,
  status: 'green',
  note: '',
  runKey: 'run-1',
  repositories: ['r'],
  merged: {},
  covers: [],
  depends: [],
  manual: false,
  mergeOk: false,
  ...overrides,
});

describe('BacklogQueries view', () => {
  it('carries the description, covers and depends of each task', async () => {
    const queries = queriesOver('green', [], [task('a', { covers: ['M3.R1'], depends: ['b'] })]);
    const [view] = (await queries.view('shop')).tasks;
    expect(view).toMatchObject({ description: 'about a', covers: ['M3.R1'], depends: ['b'] });
  });

  it('says a task waits for OK only when it started, is green, has no OK and the mode or the task asks for it', async () => {
    const tasks = [
      task('plain'),
      task('manual', { manual: true }),
      task('okd', { mergeOk: true }),
      task('no-run', { runKey: null }),
      task('red', { status: 'red' }),
    ];
    const waits = async (mode: 'green' | 'ok') =>
      Object.fromEntries(
        (await queriesOver(mode, [], tasks).view('shop')).tasks.map((item) => [item.slug, item.waitsForOk]),
      );
    expect(await waits('ok')).toEqual({ plain: true, manual: true, okd: false, 'no-run': false, red: false });
    expect(await waits('green')).toEqual({ plain: false, manual: true, okd: false, 'no-run': false, red: false });
  });

  it('lists the merged covering tasks in task order for a closed requirement only', async () => {
    const tasks = [
      task('first', { status: 'merged', covers: ['M3.R1', 'M3.R3'] }),
      task('running', { status: 'running', covers: ['M3.R1'] }),
      task('second', { status: 'merged', covers: ['M3.R1'] }),
    ];
    const requirements = [requirement('M3.R1', 'closed'), requirement('M3.R2', 'closed'), requirement('M3.R3', 'open')];
    const view = await queriesOver('green', requirements, tasks).list();
    expect(view[0].requirements.map((item) => item.closedBy)).toEqual([['first', 'second'], [], []]);
  });
});
