import type { CallStart, PingDraft, RequestUsage } from './agent-call';
import { AgentCallRepository } from './agent-call.repository';
import { repositoryDatabase } from './repository.spec-helpers';

const AT = '2026-11-26T10:00:00.000Z';
const LATER = '2026-11-26T10:05:00.000Z';

function start(values: Partial<CallStart> = {}): CallStart {
  return {
    kind: 'call',
    startedAt: AT,
    resumed: false,
    runtime: 'claude',
    model: 'claude-opus-5-5',
    requestText: 'do it',
    runKey: 'run-1',
    step: 'implement',
    chatId: 'chat-1',
    ...values,
  };
}

function request(values: Partial<RequestUsage> = {}): RequestUsage {
  return {
    model: 'claude-opus-5-5',
    input: 10,
    cacheRead: 100,
    cacheWrite: 20,
    output: 5,
    usd: 0.5,
    price: { input: 5, output: 25 },
    ...values,
  };
}

function ping(values: Partial<PingDraft> = {}): PingDraft {
  return {
    startedAt: AT,
    dueAt: '2026-11-26T09:50:00.000Z',
    chatId: 'chat-1',
    previousId: 1,
    runKey: 'run-1',
    runtime: 'claude',
    model: 'claude-opus-5-5',
    requestText: 'ping',
    ...values,
  };
}

async function withLog(test: (log: AgentCallRepository) => Promise<void>): Promise<void> {
  const db = await repositoryDatabase();
  try {
    await test(db.app.get(AgentCallRepository));
  } finally {
    await db.close();
  }
}

const end = { endKind: 'done', finishedAt: LATER, durationMs: 300000, responseText: 'ok' } as const;

describe('AgentCallRepository', () => {
  it('opens a running row with its request', () =>
    withLog(async (log) => {
      const id = await log.open(start({ plannerLevel: 'run', purpose: 'plan', startReason: 'first' }));
      const row = await log.lastRowOfChat('chat-1');
      expect(row).toMatchObject({
        id,
        kind: 'call',
        endKind: 'running',
        finishedAt: '',
        stepStatId: 0,
        runKey: 'run-1',
        plannerLevel: 'run',
        purpose: 'plan',
        startReason: 'first',
        requestText: 'do it',
        resumed: 0,
        ownUsd: 0,
      });
    }));

  it('persists each request at once, merging a model into one usage entry', () =>
    withLog(async (log) => {
      const id = await log.open(start());
      await log.addRequest(id, request());
      expect(await log.spendOfRun('run-1')).toBe(0.5);
      await log.addRequest(id, request({ usd: 0.25 }));
      await log.addRequest(
        id,
        request({ model: 'claude-sonnet-5-5', input: 1, cacheRead: 0, cacheWrite: 0, output: 1, usd: 0.1 }),
      );
      const row = await log.lastRowOfChat('chat-1');
      expect(row).toMatchObject({ inputTokens: 21, cacheReadTokens: 200, cacheWriteTokens: 40, outputTokens: 11 });
      expect(row?.ownUsd).toBeCloseTo(0.85);
      const usage = JSON.parse(row?.usage ?? '[]') as { model: string; input: number; usd: number }[];
      expect(usage.map((entry) => [entry.model, entry.input])).toEqual([
        ['claude-opus-5-5', 20],
        ['claude-sonnet-5-5', 1],
      ]);
      expect(Object.keys(JSON.parse(row?.prices ?? '{}'))).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    }));

  it('loses nothing when requests are added at the same time', () =>
    withLog(async (log) => {
      const id = await log.open(start());
      await Promise.all(Array.from({ length: 20 }, () => log.addRequest(id, request({ usd: 1, output: 1 }))));
      const row = await log.lastRowOfChat('chat-1');
      expect(row).toMatchObject({ outputTokens: 20, ownUsd: 20 });
      expect(JSON.parse(row?.usage ?? '[]')).toHaveLength(1);
    }));

  it('finishes a row with its end, response and the totals the CLI reported', () =>
    withLog(async (log) => {
      const id = await log.open(start());
      await log.addRequest(id, request());
      await log.finish(id, {
        ...end,
        endKind: 'limit',
        limitWindow: 'five-hour',
        limitResetsAt: '2026-11-26T15:00:00.000Z',
        reported: { usd: 7, tokensIn: 700, tokensOut: 70 },
      });
      expect(await log.lastRowOfChat('chat-1')).toMatchObject({
        endKind: 'limit',
        limitWindow: 'five-hour',
        limitResetsAt: '2026-11-26T15:00:00.000Z',
        finishedAt: LATER,
        durationMs: 300000,
        responseText: 'ok',
        reportedUsd: 7,
        ownUsd: 0.5,
      });
    }));

  it('stores the ties of a turn', () =>
    withLog(async (log) => {
      const id = await log.open(start({ runKey: undefined, turnKey: 'turn-1' }));
      await log.setTies(id, [{ task: 'a-task', general: true }]);
      expect(JSON.parse((await log.lastRowOfChat('chat-1'))?.ties ?? '[]')).toEqual([
        { task: 'a-task', general: true },
      ]);
    }));

  it('links exactly the given rows to a visit', () =>
    withLog(async (log) => {
      const first = await log.open(start({ attemptId: 'a1', chatId: 'c-first' }));
      const second = await log.open(start({ attemptId: 'a1', chatId: 'c-second' }));
      const third = await log.open(start({ attemptId: 'a1', chatId: 'c-third' }));
      await log.linkVisit([], 9);
      expect(await log.rowsOfAttempt('a1')).toHaveLength(3);
      await log.linkVisit([first, third], 9);
      expect((await log.rowsOfAttempt('a1')).map((row) => row.id)).toEqual([second]);
    }));

  it('closes the open rows of an attempt only and keeps their cost', () =>
    withLog(async (log) => {
      const open = await log.open(start({ attemptId: 'a1', chatId: 'c-open' }));
      await log.addRequest(open, request());
      const done = await log.open(start({ attemptId: 'a1', chatId: 'c-done' }));
      await log.finish(done, end);
      const other = await log.open(start({ attemptId: 'a2', chatId: 'c-other' }));
      await log.closeLeftOpen({ attemptId: 'a1' }, LATER);
      expect(await log.lastRowOfChat('c-open')).toMatchObject({
        endKind: 'failed',
        errorText: 'process died',
        finishedAt: LATER,
        ownUsd: 0.5,
      });
      expect((await log.lastRowOfChat('c-done'))?.endKind).toBe('done');
      expect(await log.lastRowOfChat('c-other')).toMatchObject({ id: other, endKind: 'running' });
    }));

  it('closes the open rows of a backlog turn only', () =>
    withLog(async (log) => {
      await log.open(start({ runKey: undefined, turnKey: 'turn-1', chatId: 'c-turn' }));
      await log.open(start({ runKey: undefined, turnKey: 'turn-2', chatId: 'c-turn-2' }));
      await log.closeLeftOpen({ turnKey: 'turn-1' }, LATER);
      expect((await log.lastRowOfChat('c-turn'))?.endKind).toBe('failed');
      expect((await log.lastRowOfChat('c-turn-2'))?.endKind).toBe('running');
    }));

  it('closes the open pings only', () =>
    withLog(async (log) => {
      const call = await log.open(start());
      const pinged = await log.insertPing(ping({ previousId: call }));
      await log.addRequest(pinged ?? 0, request({ usd: 0.1 }));
      await log.closeLeftOpen({ pings: true }, LATER);
      expect(await log.lastRowOfChat('chat-1')).toMatchObject({ id: pinged, endKind: 'failed', ownUsd: 0.1 });
      await log.finish(call, end);
      const again = await log.open(start({ chatId: 'chat-2' }));
      await log.closeLeftOpen({ pings: true }, LATER);
      expect((await log.lastRowOfChat('chat-2'))?.id).toBe(again);
      expect((await log.lastRowOfChat('chat-2'))?.endKind).toBe('running');
    }));

  it('gives no row for a second ping of the same chat and due time', () =>
    withLog(async (log) => {
      const first = await log.insertPing(ping());
      expect(first).toEqual(expect.any(Number));
      expect(await log.insertPing(ping())).toBeNull();
      expect(await log.insertPing(ping({ dueAt: '2026-11-26T10:40:00.000Z' }))).toEqual(expect.any(Number));
      expect(await log.insertPing(ping({ chatId: 'chat-2' }))).toEqual(expect.any(Number));
      expect(await log.lastRowOfChat('chat-1')).toMatchObject({ kind: 'ping', startReason: 'ping', resumed: 1 });
    }));

  it("marks a stop on the chat's last row, and none for an unknown chat", () =>
    withLog(async (log) => {
      const call = await log.open(start({ backlog: 'main', taskSlug: 'a-task', epicKey: 'epic-1', effort: 'high' }));
      const stop = await log.addStop('chat-1', 'cap-reached', LATER);
      expect(await log.lastRowOfChat('chat-1')).toMatchObject({
        id: stop,
        kind: 'ping-stop',
        stopReason: 'cap-reached',
        previousId: call,
        runKey: 'run-1',
        step: 'implement',
        runtime: 'claude',
        model: 'claude-opus-5-5',
        effort: 'high',
        backlog: 'main',
        taskSlug: 'a-task',
        epicKey: 'epic-1',
        startedAt: LATER,
      });
      expect(await log.addStop('chat-none', 'run-closed', LATER)).toBeNull();
    }));

  it('sums the spend and tokens of a run over calls, helpers and pings, cache tokens included', () =>
    withLog(async (log) => {
      const call = await log.open(start());
      await log.addRequest(call, request());
      const helper = await log.open(start({ kind: 'helper', parentId: call, chatId: 'c-helper' }));
      await log.addRequest(helper, request({ usd: 0.25, input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }));
      const pinged = await log.insertPing(ping({ previousId: call }));
      await log.addRequest(pinged ?? 0, request({ usd: 0.125, input: 0, cacheRead: 100, cacheWrite: 0, output: 1 }));
      await log.open(start({ runKey: 'run-2', chatId: 'c-run-2' }));
      expect(await log.spendOfRun('run-1')).toBe(0.875);
      expect(await log.tokensOfRun('run-1')).toBe(135 + 10 + 101);
      expect(await log.spendOfRun('run-none')).toBe(0);
      expect(await log.tokensOfRun('run-none')).toBe(0);
    }));

  it('sums the spend and tokens of a backlog turn and of a chat', () =>
    withLog(async (log) => {
      const turn = await log.open(start({ runKey: undefined, turnKey: 'turn-1', chatId: 'c-turn' }));
      await log.addRequest(turn, request({ usd: 0.75 }));
      const resumed = await log.open(start({ chatId: 'chat-1', resumed: true }));
      await log.addRequest(resumed, request({ usd: 1 }));
      const again = await log.open(start({ chatId: 'chat-1', resumed: true }));
      await log.addRequest(again, request({ usd: 2 }));
      expect(await log.spendOfTurn('turn-1')).toBe(0.75);
      expect(await log.tokensOfTurn('turn-1')).toBe(135);
      expect(await log.spendOfTurn('turn-2')).toBe(0);
      expect(await log.spendOfChat('chat-1')).toBe(3);
      expect(await log.lastRowOfChat('chat-1')).toMatchObject({ id: again });
    }));

  it('reads an attempt over its unlinked rows only', () =>
    withLog(async (log) => {
      const linked = await log.open(start({ attemptId: 'a1', chatId: 'c-linked' }));
      await log.addRequest(linked, request({ usd: 1 }));
      const open = await log.open(start({ attemptId: 'a1', chatId: 'c-open' }));
      await log.addRequest(open, request({ usd: 0.5 }));
      await log.linkVisit([linked], 4);
      expect(await log.spendOfAttempt('a1')).toBe(0.5);
      expect((await log.rowsOfAttempt('a1')).map((row) => row.id)).toEqual([open]);
      expect(await log.spendOfRun('run-1')).toBe(1.5);
    }));
});
