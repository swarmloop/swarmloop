import { AgentCallQueries } from './agent-call-queries';
import { at, seedCall, seedPing } from './agent-call-queries.spec-helpers';
import { AgentCallRepository } from './agent-call.repository';
import { repositoryDatabase } from './repository.spec-helpers';
import { DataSource } from 'typeorm';

async function withLog(test: (log: AgentCallRepository, queries: AgentCallQueries) => Promise<void>): Promise<void> {
  const db = await repositoryDatabase();
  try {
    await test(db.app.get(AgentCallRepository), new AgentCallQueries(db.app.get(DataSource)));
  } finally {
    await db.close();
  }
}

describe('AgentCallQueries totals', () => {
  async function seed(log: AgentCallRepository): Promise<void> {
    const backlog = 'bk';
    await seedCall(log, {
      usd: 1,
      start: { backlog, taskSlug: 'a', runKey: 'run-a', step: 'implement', plannerLevel: undefined },
    });
    await seedCall(log, {
      usd: 2,
      start: { backlog, taskSlug: 'a', runKey: 'run-a', step: 'plan', plannerLevel: 'run' },
    });
    await seedCall(log, {
      usd: 4,
      start: { backlog, epicKey: 'epic-1', runKey: 'epic-1-run', step: 'plan', plannerLevel: 'epic' },
    });
    await seedCall(log, { usd: 8, start: { backlog, epicKey: 'epic-1', runKey: 'part-1', step: 'implement' } });
    await seedCall(log, { usd: 16, start: { backlog, epicKey: 'epic-1', runKey: 'part-2', step: 'implement' } });
    await seedCall(log, {
      usd: 0.5,
      start: { backlog, turnKey: 'turn-1', step: 'backlog-plan', plannerLevel: 'backlog', purpose: 'backlog-turn' },
      ties: [
        { task: 'a', general: false },
        { task: 'b', general: false },
        { epic: 'epic-1', general: false },
      ],
    });
  }

  it('sums a task and shows the backlog turns tied to it as their own line', async () => {
    await withLog(async (log, queries) => {
      await seed(log);
      const lines = await queries.totals('task');
      expect(lines).toEqual([
        expect.objectContaining({ key: 'a', backlogTurns: false, usd: 3, calls: 2 }),
        expect.objectContaining({ key: 'a', backlogTurns: true, usd: 0.5, calls: 1 }),
        expect.objectContaining({ key: 'b', backlogTurns: true, usd: 0.5, calls: 1 }),
      ]);
    });
  });

  it('sums an epic with its parts and its backlog turns', async () => {
    await withLog(async (log, queries) => {
      await seed(log);
      const lines = await queries.totals('epic');
      expect(lines).toEqual([
        expect.objectContaining({ key: 'epic-1', part: null, backlogTurns: false, usd: 28, calls: 3 }),
        expect.objectContaining({ key: 'epic-1', part: 'epic-1-run', usd: 4 }),
        expect.objectContaining({ key: 'epic-1', part: 'part-1', usd: 8 }),
        expect.objectContaining({ key: 'epic-1', part: 'part-2', usd: 16 }),
        expect.objectContaining({ key: 'epic-1', part: null, backlogTurns: true, usd: 0.5 }),
      ]);
    });
  });

  it('does not count the mark where the pings of a chat stopped as a call', async () => {
    await withLog(async (log, queries) => {
      await seedCall(log, { usd: 1, start: { taskSlug: 'a', step: 'implement', chatId: 'c1' } });
      await log.addStop('c1', 'run-closed', at(11));
      const [line] = await queries.totals('step');
      expect(line).toEqual(expect.objectContaining({ key: 'implement', calls: 1 }));
    });
  });

  it('sums by step and by planner level', async () => {
    await withLog(async (log, queries) => {
      await seed(log);
      const steps = Object.fromEntries((await queries.totals('step')).map((line) => [line.key, line.usd]));
      expect(steps).toEqual({ implement: 25, plan: 6, 'backlog-plan': 0.5 });
      const levels = Object.fromEntries((await queries.totals('level')).map((line) => [line.key, line.usd]));
      expect(levels).toEqual({ run: 2, epic: 4, backlog: 0.5 });
    });
  });

  it('counts a turn tied to two tasks once in the backlog total', async () => {
    await withLog(async (log, queries) => {
      await seed(log);
      const [backlog] = await queries.totals('backlog');
      expect(backlog).toEqual(expect.objectContaining({ key: 'bk', usd: 31.5, calls: 6 }));
    });
  });
});

describe('AgentCallQueries timeline', () => {
  it('returns the rows of a task in order with their kind, end and links', async () => {
    await withLog(async (log, queries) => {
      const task = { taskSlug: 'a', runKey: 'run-1', step: 'implement' };
      const first = await seedCall(log, { usd: 1, start: { ...task, startedAt: at(10), chatId: 'c1' } });
      const resumed = await seedCall(log, {
        usd: 1,
        start: { ...task, startedAt: at(10, 30), chatId: 'c1', resumed: true, previousId: first },
      });
      const ping = await seedPing(log, {
        chatId: 'c1',
        previousId: resumed,
        startedAt: at(11, 20),
        usd: 0.01,
        taskSlug: 'a',
      });
      const limited = await seedCall(log, {
        usd: 1,
        start: { ...task, startedAt: at(12), chatId: 'c1', resumed: true, previousId: ping },
        end: { endKind: 'limit', limitWindow: '5h' },
      });
      const failover = await seedCall(log, {
        usd: 1,
        start: {
          ...task,
          startedAt: at(12, 1),
          chatId: 'c2',
          runtime: 'codex',
          model: 'gpt-5',
          effort: 'high',
          replacesId: limited,
        },
      });
      const lastPing = await seedPing(log, {
        chatId: 'c2',
        previousId: failover,
        startedAt: at(13),
        usd: 0.01,
        taskSlug: 'a',
      });
      await seedCall(log, { usd: 9, start: { taskSlug: 'other', startedAt: at(9) } });

      const entries = await queries.timeline('task', 'a');
      expect(entries.map((entry) => [entry.id, entry.kind, entry.end, entry.chatId, entry.runtime])).toEqual([
        [first, 'new-chat', 'done', 'c1', 'claude'],
        [resumed, 'resume', 'done', 'c1', 'claude'],
        [ping, 'ping', 'done', 'c1', 'claude'],
        [limited, 'resume', 'limit', 'c1', 'claude'],
        [failover, 'failover', 'done', 'c2', 'codex'],
        [lastPing, 'ping', 'done', 'c2', 'claude'],
      ]);
      expect(entries[1]).toEqual(
        expect.objectContaining({ step: 'implement', model: 'claude-opus-5-5', usd: 1, previousId: first }),
      );
      expect(entries[4]).toEqual(expect.objectContaining({ effort: 'high', model: 'gpt-5', replacesId: limited }));
      expect(entries[2]?.previousId).toBe(resumed);
    });
  });

  it('reads a step and an epic by their own key', async () => {
    await withLog(async (log, queries) => {
      await seedCall(log, { start: { step: 'plan', epicKey: 'e1' } });
      await seedCall(log, { start: { step: 'implement', epicKey: 'e1' } });
      expect((await queries.timeline('step', 'plan')).length).toBe(1);
      expect((await queries.timeline('epic', 'e1')).length).toBe(2);
    });
  });
});

describe('AgentCallQueries keep-warm', () => {
  it('counts hits, misses and a failed ping, and the saving of a call resumed after a kept-warm pause', async () => {
    await withLog(async (log, queries) => {
      const chat = { chatId: 'c1', runKey: 'run-1' };
      const first = await seedCall(log, {
        usd: 1,
        start: { ...chat, startedAt: at(10) },
        end: { finishedAt: at(10, 5) },
      });
      await seedPing(log, {
        chatId: 'c1',
        previousId: first,
        startedAt: at(10, 55),
        usd: 0.01,
        cacheRead: 1000,
        cacheWrite: 10,
      });
      await seedPing(log, {
        chatId: 'c1',
        previousId: first,
        startedAt: at(11, 45),
        usd: 0.01,
        cacheRead: 1000,
        cacheWrite: 500,
      });
      await seedPing(log, { chatId: 'c1', previousId: first, startedAt: at(12, 20), usd: 0, end: 'failed' });
      await seedCall(log, {
        usd: 0.5,
        cacheRead: 50_000,
        start: { ...chat, startedAt: at(12, 35), resumed: true, previousId: first },
      });
      const view = await queries.keepWarm(60);
      expect(view).toEqual(expect.objectContaining({ ttlMinutes: 60, pings: 3, hits: 1, misses: 1 }));
      expect(view.cost).toBeCloseTo(0.02);
      expect(view.saving).toBeCloseTo((50_000 * 7.8) / 1e6 - 0.02);
      expect(view.chats).toEqual([expect.objectContaining({ chatId: 'c1', pings: 3 })]);
    });
  });

  it('gives no saving when the pause is within the lifetime or no ping came between', async () => {
    await withLog(async (log, queries) => {
      const first = await seedCall(log, { start: { chatId: 'c1', startedAt: at(10) }, end: { finishedAt: at(10, 5) } });
      await seedPing(log, { chatId: 'c1', previousId: first, startedAt: at(10, 55), usd: 0.01 });
      await seedCall(log, {
        cacheRead: 50_000,
        start: { chatId: 'c1', startedAt: at(12), resumed: true, previousId: first },
      });
      expect((await queries.keepWarm(60)).saving).toBeGreaterThan(0);
      expect((await queries.keepWarm(180)).saving).toBe(0);
      const lone = await seedCall(log, { start: { chatId: 'c2', startedAt: at(10) }, end: { finishedAt: at(10, 5) } });
      await seedCall(log, {
        cacheRead: 50_000,
        start: { chatId: 'c2', startedAt: at(12), resumed: true, previousId: lone },
      });
      expect((await queries.keepWarm(60)).chats.map((chat) => chat.chatId)).toEqual(['c1']);
    });
  });

  it('counts the pings of a chat that closed without a call as spent with no saving', async () => {
    await withLog(async (log, queries) => {
      const first = await seedCall(log, { start: { chatId: 'c1', startedAt: at(10) }, end: { finishedAt: at(10, 5) } });
      await seedPing(log, { chatId: 'c1', previousId: first, startedAt: at(10, 55), usd: 0.02, cacheRead: 1000 });
      const view = await queries.keepWarm(60);
      expect(view).toEqual(expect.objectContaining({ pings: 1, hits: 1, saving: 0 }));
      expect(view.cost).toBeCloseTo(0.02);
    });
  });
});
