import 'reflect-metadata';
import { observeChain } from './flow-routes-chain.spec-helpers';
import {
  AGENT,
  circles,
  observeAnswers,
  observeDoor,
  observeStates,
  PERSON,
  observeWait,
  PLANNERS,
  REBASE,
  ROUND,
  SETTLE,
  routeGraph,
  TASK,
  WAIT_MAIN,
  type Observed,
  type RouteGraph,
} from './flow-routes.spec-helpers';

/** The route graph of the flow, built from the decisions the real code takes in every state class. */
describe('the routes of the flow', () => {
  let single: Observed;
  let split: Observed;

  beforeAll(async () => {
    const [states, answers, door, chain] = await Promise.all([
      observeStates(),
      observeAnswers(),
      observeDoor(),
      observeChain(),
    ]);
    single = { states: {}, answers, door, chain, wait: observeWait() };
    split = { states, answers, door, chain, wait: observeWait() };
  });

  it('reads the real decisions of every state class', () => {
    expect(Object.keys(split.states)).toEqual([
      'tasks running',
      'return after the last merge',
      'requirements return after the last merge',
      'gap review before the last merge',
      'gap taken',
      'subtask questions open',
    ]);
    expect(split.states['return after the last merge'].runner).toBe('agent');
    expect(split.states['requirements return after the last merge'].runner).toBe('agent');
    expect(split.states['gap review before the last merge']).toEqual({ runner: 'split', then: 'task' });
    expect(split.states['subtask questions open']).toEqual({ runner: 'split', then: 'person' });
    expect(split.door).toBe('same');
    expect(split.chain).toEqual({
      alone: ['run-planner', 'starter'],
      task: ['run-planner', 'epic-planner', 'starter'],
      backlogStarter: true,
      refusal: { again: true, ends: true },
      subtaskAsks: false,
    });
    expect(single.answers.holds).toMatchObject({ step: 'implement', reviewers: 0 });
    expect(single.answers['ruled-out']).toMatchObject({ reviewers: 0 });
    expect(single.answers.unanswered).toMatchObject({ waiting: true, asksPlanner: true });
    expect(single.answers.escalated).toMatchObject({ waiting: true, asksPlanner: false });
  });

  it('has no path from a return of code-review or CI back to a review round for a single run', () => {
    expect(circles(routeGraph(single, 'single'))).toEqual([]);
  });

  it('has no path from a return back to a review round for a split parent', () => {
    expect(circles(routeGraph(split, 'split'))).toEqual([]);
  });

  it('finds the round a planner answer starts on the same head (review, plan, review)', () => {
    const base: Observed = {
      ...single,
      answers: { ...single.answers, holds: { ...single.answers.holds, reviewers: 4 } },
    };
    const found = circles(routeGraph(base, 'single'));
    expect(found.map((path) => path.join(' > '))).toContain(`${ROUND} > ${PLANNERS[0]} > ${SETTLE} > ${ROUND}`);
  });

  it('finds a door that lets the same input through, for a return and for a split pass after a taken gap', () => {
    expect(circles(routeGraph({ ...split, door: 'new' }, 'split')).length).toBeGreaterThan(0);
    expect(circles(routeGraph({ ...single, door: 'new' }, 'single')).length).toBeGreaterThan(0);
  });

  it('finds a split pass that ends a taken gap without a task', () => {
    const base: Observed = {
      ...split,
      door: 'new',
      states: { 'gap taken': { runner: 'split', then: 'next' } },
    };
    const found = circles(routeGraph(base, 'split')).map((path) => path.join(' > '));
    expect(found).toContain(`${ROUND} > split pass: gap taken > implement-improve > checks > code-review > ${ROUND}`);
  });

  it.each([AGENT, TASK, PERSON])(
    'does not count a path through %s, which changes the tree or asks a person',
    (node) => {
      const graph = routeGraph(split, 'split');
      const through: RouteGraph = {
        ...graph,
        edges: [
          ...graph.edges,
          { from: 'merge-request', to: node, why: 'added' },
          { from: node, to: ROUND, why: 'added' },
        ],
      };
      expect(circles(through)).toEqual([]);
    },
  );

  it('has a run answered under a red main wait for a green main and leave it only through Rebase, never as a wait for a person', () => {
    const leaving = (observed: Observed) =>
      routeGraph(observed, 'split')
        .edges.filter((edge) => edge.from === WAIT_MAIN)
        .map((edge) => edge.to);
    expect(split.wait.actions).toContain('rebase');
    expect(leaving(split)).toEqual([REBASE]);
    expect(routeGraph(split, 'split').changes.has(REBASE)).toBe(true);
    expect(routeGraph(split, 'split').edges).toContainEqual(
      expect.objectContaining({ from: PLANNERS[2], to: WAIT_MAIN }),
    );
    expect(leaving({ ...split, wait: { actions: ['stop'], phase: 'person' } })).toEqual([PERSON]);
  });
});
