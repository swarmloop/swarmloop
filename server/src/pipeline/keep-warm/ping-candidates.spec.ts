import type { RunStateChange } from '../../history/run-state';
import type { ContainerGate } from '../../sandbox/container-gate';
import { keepWarmDatabase } from './ping-candidates.spec-helpers';
import { PingCandidates } from './ping-candidates';

type Setup = Awaited<ReturnType<typeof keepWarmDatabase>>;

const MINUTE_MS = 60_000;

async function withCandidates(
  test: (h: Setup, candidates: PingCandidates, pause: (paused: boolean) => void) => Promise<void>,
): Promise<void> {
  const h = await keepWarmDatabase();
  let paused = false;
  const gate = { paused: () => paused } as ContainerGate;
  try {
    await test(h, new PingCandidates(h.runs, h.calls, gate, h.clock, h.config), (value) => (paused = value));
  } finally {
    await h.close();
  }
}

const chatsOf = async (candidates: PingCandidates): Promise<string[]> =>
  (await candidates.pass()).map((due) => due.chat.chatId);

describe('PingCandidates', () => {
  it('picks a chat idle 50 minutes, due at its last row plus the cache lifetime less ten minutes', () =>
    withCandidates(async (h, candidates) => {
      await h.run('run-a');
      const { chatId, callId } = await h.chat('run-a', { idleMin: 50 });
      const [due, ...others] = await candidates.pass();
      expect(others).toEqual([]);
      expect(due).toMatchObject({
        run: { key: 'run-a' },
        last: { id: callId, model: 'claude-opus-5-5', effort: 'high' },
        chat: { chatId, previousId: callId, dueAt: h.ago(0) },
      });
      expect(await h.stops()).toEqual([]);
    }));

  it('leaves out a chat younger than that, and picks it once the time has come', () =>
    withCandidates(async (h, candidates) => {
      await h.run('run-a');
      const { chatId } = await h.chat('run-a', { idleMin: 30 });
      expect(await chatsOf(candidates)).toEqual([]);
      h.clock.advance(20 * MINUTE_MS);
      expect(await chatsOf(candidates)).toEqual([chatId]);
    }));

  it("picks the chats a visit resumes: the plan chat, the implement chat and each reviewer's chat", () =>
    withCandidates(async (h, candidates) => {
      await h.run('run-a');
      const wanted = await Promise.all(
        ['plan', 'implement', 'code-review-security', 'code-review-quality'].map((home) =>
          h.chat('run-a', { home, idleMin: 55 }),
        ),
      );
      expect((await chatsOf(candidates)).sort()).toEqual(wanted.map((chat) => chat.chatId).sort());
    }));

  it('leaves out the review report, a backlog turn and a chat a fresh chat replaced', () =>
    withCandidates(async (h, candidates) => {
      await h.run('run-a');
      await h.chat('run-a', { home: 'code-review-report', idleMin: 55 });
      await h.chat('run-a', { home: 'backlog-plan', idleMin: 55 });
      await h.chat('run-a', { idleMin: 90, replaced: true });
      const { chatId } = await h.chat('run-a', { idleMin: 55 });
      expect(await chatsOf(candidates)).toEqual([chatId]);
    }));

  it('leaves out a chat whose row is open', () =>
    withCandidates(async (h, candidates) => {
      await h.run('run-a');
      await h.chat('run-a', { idleMin: 55, open: true });
      expect(await chatsOf(candidates)).toEqual([]);
    }));

  it('leaves out every chat while the server is paused, and writes no stop', () =>
    withCandidates(async (h, candidates, pause) => {
      await h.run('run-a');
      const { chatId, callId } = await h.chat('run-a', { idleMin: 55 });
      await h.ping('run-a', chatId, callId, 1);
      await h.run('run-b', { status: 'done', merge: { merged: {} } });
      pause(true);
      expect(await chatsOf(candidates)).toEqual([]);
      expect(await h.stops()).toEqual([]);
      pause(false);
      await h.chat('run-a', { home: 'plan', idleMin: 55 });
      expect(await chatsOf(candidates)).toHaveLength(1);
    }));

  it('leaves out a chat on a runtime that declares no prompt cache, and a model it does not know', () =>
    withCandidates(async (h, candidates) => {
      await h.run('run-a');
      await h.chat('run-a', { home: 'plan', idleMin: 55, runtime: 'codex', model: 'gpt-x' });
      await h.chat('run-a', { home: 'implement', idleMin: 55, model: 'claude-unknown' });
      expect(await chatsOf(candidates)).toEqual([]);
      expect(await h.stops()).toEqual([]);
    }));

  describe('a run that is over', () => {
    const states: [string, RunStateChange][] = [
      ['merged', { status: 'done', merge: { merged: {} } }],
      ['done', { status: 'done' }],
      ['failed', { status: 'failed' }],
      ['skipped', { status: 'waiting', reason: { code: 'SKIPPED', message: 'skipped' } }],
    ];
    it.each(states)('leaves out the chats of a run that is %s', (_name, state) =>
      withCandidates(async (h, candidates) => {
        await h.run('run-a', state);
        await h.chat('run-a', { idleMin: 55 });
        expect(await chatsOf(candidates)).toEqual([]);
      }),
    );

    it('writes the stop of a chat that was being pinged once, with its reason', () =>
      withCandidates(async (h, candidates) => {
        await h.run('run-a', { status: 'done', merge: { merged: {} } });
        const { chatId, callId } = await h.chat('run-a', { idleMin: 55 });
        await h.ping('run-a', chatId, callId, 1, { idleMin: 5 });
        await h.chat('run-a', { home: 'plan', idleMin: 55 });

        expect(await chatsOf(candidates)).toEqual([]);
        expect(await h.stops()).toEqual([[chatId, 'run-closed']]);
        expect(await chatsOf(candidates)).toEqual([]);
        expect(await h.stops()).toEqual([[chatId, 'run-closed']]);
      }));

    it('writes person-stopped for the chat of a run a person stopped, and pings it again after its next call', () =>
      withCandidates(async (h, candidates) => {
        await h.run('run-a', { status: 'blocked', reason: { code: 'STOPPED', message: 'stopped' } });
        const { chatId, callId } = await h.chat('run-a', { idleMin: 55 });
        await h.ping('run-a', chatId, callId, 1, { idleMin: 5 });
        expect(await chatsOf(candidates)).toEqual([]);
        expect(await h.stops()).toEqual([[chatId, 'person-stopped']]);

        await h.run('run-a', { status: 'waiting' });
        expect(await chatsOf(candidates)).toEqual([]);
        await h.chat('run-a', { chatId, idleMin: 55 });
        expect(await chatsOf(candidates)).toEqual([chatId]);
      }));

    it('writes no stop for a chat that was never pinged', () =>
      withCandidates(async (h, candidates) => {
        await h.run('run-a', { status: 'failed' });
        await h.chat('run-a', { idleMin: 55 });
        await candidates.pass();
        expect(await h.stops()).toEqual([]);
      }));
  });

  describe("an epic's chats", () => {
    it("keeps picking an epic's parent until the epic merges, then writes epic-merged", () =>
      withCandidates(async (h, candidates) => {
        await h.run('epic-1', { status: 'done' }, { epicAt: '2026-01-01T00:00:00.000Z' });
        const { chatId, callId } = await h.chat('epic-1', { home: 'plan', idleMin: 55 });
        expect(await chatsOf(candidates)).toEqual([chatId]);

        await h.ping('epic-1', chatId, callId, 1, { idleMin: 5 });
        await h.run('epic-1', { status: 'done', merge: { merged: {} } }, { epicAt: '2026-01-01T00:00:00.000Z' });
        expect(await chatsOf(candidates)).toEqual([]);
        expect(await h.stops()).toEqual([[chatId, 'epic-merged']]);
      }));

    it('stops the chat of a part when the part closes, which is not the epic', () =>
      withCandidates(async (h, candidates) => {
        const parent = await h.run('epic-1', { status: 'running' }, { epicAt: '2026-01-01T00:00:00.000Z' });
        const part = await h.run('part-1', { status: 'done' }, { parentRunId: parent.id, taskId: 't1' });
        const { chatId, callId } = await h.chat(part.key, { idleMin: 55 });
        await h.ping(part.key, chatId, callId, 1, { idleMin: 5 });
        expect(await chatsOf(candidates)).toEqual([]);
        expect(await h.stops()).toEqual([[chatId, 'run-closed']]);
      }));
  });

  describe('the pings of a chat', () => {
    it('stop after write price divided by read price pings without a call, with a cap-reached row', () =>
      withCandidates(async (h, candidates) => {
        await h.run('run-a');
        const { chatId, callId } = await h.chat('run-a', { idleMin: 2400 });
        for (let nth = 1; nth < 40; nth += 1) await h.ping('run-a', chatId, callId, nth, { idleMin: 55 });
        expect(await chatsOf(candidates)).toEqual([chatId]);

        await h.ping('run-a', chatId, callId, 40, { idleMin: 55 });
        expect(await chatsOf(candidates)).toEqual([]);
        expect(await h.stops()).toEqual([[chatId, 'cap-reached']]);
        expect(await chatsOf(candidates)).toEqual([]);
        expect(await h.stops()).toEqual([[chatId, 'cap-reached']]);
      }));

    it('start again after the chat has a call', () =>
      withCandidates(async (h, candidates) => {
        await h.run('run-a');
        const { chatId, callId } = await h.chat('run-a', { idleMin: 2400 });
        for (let nth = 1; nth <= 40; nth += 1) await h.ping('run-a', chatId, callId, nth, { idleMin: 55 });
        await candidates.pass();
        await h.chat('run-a', { chatId, idleMin: 55 });
        expect(await chatsOf(candidates)).toEqual([chatId]);
      }));

    it('end when the last ping failed, with a ping-failed row, until the next call', () =>
      withCandidates(async (h, candidates) => {
        await h.run('run-a');
        const { chatId, callId } = await h.chat('run-a', { idleMin: 120 });
        await h.ping('run-a', chatId, callId, 1, { idleMin: 55, endKind: 'failed' });
        expect(await chatsOf(candidates)).toEqual([]);
        expect(await h.stops()).toEqual([[chatId, 'ping-failed']]);
        expect(await chatsOf(candidates)).toEqual([]);
        expect(await h.stops()).toEqual([[chatId, 'ping-failed']]);
      }));

    it('are due again 50 minutes after the last ping', () =>
      withCandidates(async (h, candidates) => {
        await h.run('run-a');
        const { chatId, callId } = await h.chat('run-a', { idleMin: 120 });
        await h.ping('run-a', chatId, callId, 1, { idleMin: 30 });
        expect(await chatsOf(candidates)).toEqual([]);
        h.clock.advance(20 * MINUTE_MS);
        expect(await chatsOf(candidates)).toEqual([chatId]);
      }));
  });
});
