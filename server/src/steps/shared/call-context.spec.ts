import { REASON } from '../../contract/reason-words';
import type { AgentLaunchRequest } from './agent-launch-request';
import { CallContexts } from './call-context';

interface Fixture {
  runs: Record<string, { id: number; key: string; parentRunId: number | null; children?: string[] }>;
  starts?: { attemptId: string; startReason: string | null; rerunUnfinished: boolean }[];
  tasks?: Record<string, { slug: string; runKey: string }>;
}

function contexts({ runs, starts = [], tasks = {} }: Fixture): CallContexts {
  const byId = Object.values(runs);
  return new CallContexts(
    {
      findRun: async (key: string) => runs[key] ?? null,
      findById: async (id: number) => byId.find((run) => run.id === id) ?? null,
      children: async (run: { children?: string[] }) => run.children ?? [],
    } as never,
    {
      findTaskByRunKey: async (key: string) => tasks[key] ?? null,
      labelsFor: async (keys: string[]) => new Map(keys.map((key) => [key, { name: 'shop', milestone: null }])),
      listBacklogs: async () => [{ id: 4, name: 'shop' }],
    } as never,
    { findTurn: async (key: string) => (key === 'turn-1' ? { backlogId: 4 } : null) } as never,
    { forRun: async () => starts } as never,
  );
}

function request(over: Partial<AgentLaunchRequest> & { key: string; step: string }): AgentLaunchRequest {
  return { run: { id: 1, activeAttempt: 'attempt-1' }, ...over } as AgentLaunchRequest;
}

const PLAIN = { id: 1, key: 'run-1', parentRunId: null };

describe('CallContexts', () => {
  it('names the task and backlog of a plain run, with its planner as the run planner', async () => {
    const context = await contexts({
      runs: { 'run-1': PLAIN },
      tasks: { 'run-1': { slug: 'add-cart', runKey: 'run-1' } },
    }).resolve(request({ key: 'run-1', step: 'research' }));
    expect(context).toMatchObject({
      owner: 'run',
      key: 'run-1',
      backlog: 'shop',
      taskSlug: 'add-cart',
      step: 'research',
      plannerLevel: 'run',
      purpose: 'research',
      startReason: 'first',
      attemptId: 'attempt-1',
    });
    expect(context.epicKey).toBeUndefined();
  });

  it("ties a part to its epic's key and task, with its planner as the run planner", async () => {
    const context = await contexts({
      runs: {
        epic: { id: 2, key: 'epic', parentRunId: null, children: ['part'] },
        part: { id: 1, key: 'part', parentRunId: 2 },
      },
      tasks: { epic: { slug: 'checkout', runKey: 'epic' } },
    }).resolve(request({ key: 'part', step: 'plan' }));
    expect(context).toMatchObject({ epicKey: 'epic', taskSlug: 'checkout', plannerLevel: 'run', purpose: 'plan' });
  });

  it("marks the planner of an epic's parent as the epic planner", async () => {
    const context = await contexts({
      runs: { epic: { id: 1, key: 'epic', parentRunId: null, children: ['part'] } },
    }).resolve(request({ key: 'epic', step: 'plan-improve' }));
    expect(context).toMatchObject({ epicKey: 'epic', plannerLevel: 'epic', purpose: 'plan-improve' });
  });

  it("resolves a backlog planner's turn under its own key, with the backlog planner's level", async () => {
    const context = await contexts({ runs: {} }).resolve(request({ key: 'turn-1', step: 'backlog-plan' }));
    expect(context).toMatchObject({
      owner: 'turn',
      key: 'turn-1',
      backlog: 'shop',
      plannerLevel: 'backlog',
      purpose: 'backlog-turn',
      startReason: 'message',
    });
  });

  it('leaves the planner level out of a call that is no planner call', async () => {
    const context = await contexts({ runs: { 'run-1': PLAIN } }).resolve(request({ key: 'run-1', step: 'implement' }));
    expect(context.plannerLevel).toBeUndefined();
    expect(context.purpose).toBeUndefined();
  });

  it.each([
    ['a return', { startReason: REASON.returned, rerunUnfinished: false }, 'return:implement'],
    ['a retry', { startReason: null, rerunUnfinished: true }, 'retry'],
    ['a Resume after a Stop', { startReason: REASON.stopped, rerunUnfinished: false }, 'resume'],
    ['a first visit', { startReason: null, rerunUnfinished: false }, 'first'],
  ])('takes the start reason of %s from the visit start of the attempt', async (_name, start, expected) => {
    const context = await contexts({
      runs: { 'run-1': PLAIN },
      starts: [{ attemptId: 'attempt-1', ...start }],
    }).resolve(request({ key: 'run-1', step: 'implement' }));
    expect(context.startReason).toBe(expected);
  });

  it('starts a rebase as a rebase', async () => {
    const context = await contexts({ runs: { 'run-1': PLAIN } }).resolve(request({ key: 'run-1', step: 'rebase' }));
    expect(context.startReason).toBe('rebase');
  });

  it('lets the purpose a caller set win over the step, and takes the start reason from it', async () => {
    const context = await contexts({ runs: { 'run-1': PLAIN } }).resolve(
      request({ key: 'run-1', step: 'plan', call: { purpose: 'merge-look' } }),
    );
    expect(context).toMatchObject({ purpose: 'merge-look', startReason: 'merge', plannerLevel: 'run' });
  });
});
