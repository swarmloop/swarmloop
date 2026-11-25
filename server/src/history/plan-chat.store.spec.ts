import type { PlanChatEntry } from '../contract/plan-chat';
import { PlanChatStore } from './plan-chat.store';
import { repositoryDatabase } from './repository.spec-helpers';
import { RunRepository } from './run.repository';

const entry = (key: string, at: string): PlanChatEntry => ({
  key,
  role: 'person',
  author: 'ana',
  text: `text of ${key}`,
  at,
  state: 'pending',
});

describe('PlanChatStore', () => {
  it('keeps entries and revisions in the order they were appended', async () => {
    const db = await repositoryDatabase();
    try {
      await db.app.get(RunRepository).openWaiting('run-1', '/target');
      const store = db.app.get(PlanChatStore);
      await store.appendEntry('run-1', entry('message-a', '2026-01-01T00:00:00.000Z'));
      await store.appendRevision('run-1', {
        version: 2,
        reason: 'a message',
        summary: 'added one item',
        added: ['one'],
        changed: [],
        dropped: [],
        at: '2026-01-01T00:00:01.000Z',
      });
      await store.appendEntry('run-1', entry('message-b', '2026-01-01T00:00:02.000Z'));
      const log = await store.read('run-1');
      expect(log.entries.map((item) => item.key)).toEqual(['message-a', 'message-b']);
      expect(log.revisions.map((item) => item.version)).toEqual([2]);
    } finally {
      await db.close();
    }
  });

  it('writes an entry with a known key once', async () => {
    const db = await repositoryDatabase();
    try {
      await db.app.get(RunRepository).openWaiting('run-1', '/target');
      const store = db.app.get(PlanChatStore);
      await store.appendEntry('run-1', entry('message-a', '2026-01-01T00:00:00.000Z'));
      await store.appendEntry('run-1', entry('message-a', '2026-01-01T00:00:00.000Z'));
      expect((await store.read('run-1')).entries).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it('keeps every entry of writes that start together, in the order they started', async () => {
    const db = await repositoryDatabase();
    try {
      await db.app.get(RunRepository).openWaiting('run-1', '/target');
      const store = db.app.get(PlanChatStore);
      const keys = ['a', 'b', 'c', 'd', 'e'].map((name) => `message-${name}`);
      db.clock.advance(1000);
      await Promise.all(keys.map((key) => store.appendEntry('run-1', entry(key, db.clock.iso()))));
      expect((await store.read('run-1')).entries.map((item) => item.key)).toEqual(keys);
    } finally {
      await db.close();
    }
  });

  it('refuses a run that is missing and still writes the next one', async () => {
    const db = await repositoryDatabase();
    try {
      await db.app.get(RunRepository).openWaiting('run-1', '/target');
      const store = db.app.get(PlanChatStore);
      await expect(store.appendEntry('gone', entry('message-a', '2026-01-01T00:00:00.000Z'))).rejects.toThrow(
        'gone is missing',
      );
      await store.appendEntry('run-1', entry('message-b', '2026-01-01T00:00:00.000Z'));
      expect((await store.read('run-1')).entries).toHaveLength(1);
      expect((await store.read('gone')).entries).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('lists pending person messages in order of time, and marks them taken once', async () => {
    const db = await repositoryDatabase();
    try {
      await db.app.get(RunRepository).openWaiting('run-1', '/target');
      const store = db.app.get(PlanChatStore);
      await store.appendEntry('run-1', entry('message-late', '2026-01-01T00:00:05.000Z'));
      await store.appendEntry('run-1', entry('message-early', '2026-01-01T00:00:01.000Z'));
      await store.appendEntry('run-1', { ...entry('reply-1', '2026-01-01T00:00:02.000Z'), role: 'planner' });
      expect((await store.pending('run-1')).map((item) => item.key)).toEqual(['message-early', 'message-late']);
      await store.markTaken('run-1', ['message-early', 'unknown']);
      expect((await store.pending('run-1')).map((item) => item.key)).toEqual(['message-late']);
      const once = await store.read('run-1');
      await store.markTaken('run-1', ['message-early']);
      expect(await store.read('run-1')).toEqual(once);
      expect(once.entries.find((item) => item.key === 'message-early')?.state).toBe('taken');
    } finally {
      await db.close();
    }
  });
  it('keeps a step question and its answer apart from the person messages, and gives an answer once', async () => {
    const db = await repositoryDatabase();
    try {
      await db.app.get(RunRepository).openWaiting('run-1', '/target');
      const store = db.app.get(PlanChatStore);
      const asked = (key: string, at: string): PlanChatEntry => ({
        ...entry(key, at),
        role: 'planner',
        kind: 'question',
        from: 'implement',
      });
      await store.appendEntry('run-1', entry('message-a', '2026-01-01T00:00:01.000Z'));
      await store.appendEntry('run-1', asked('ask-implement-2', '2026-01-01T00:00:03.000Z'));
      await store.appendEntry('run-1', asked('ask-implement-1', '2026-01-01T00:00:02.000Z'));
      await store.appendEntry('run-1', asked('ask-implement-1', '2026-01-01T00:00:09.000Z'));
      expect((await store.pending('run-1')).map((item) => item.key)).toEqual(['message-a']);
      expect((await store.pendingQuestions('run-1')).map((item) => item.key)).toEqual([
        'ask-implement-1',
        'ask-implement-2',
      ]);
      expect(await store.answerFor('run-1', 'implement')).toBeNull();
      await store.appendEntry('run-1', {
        ...entry('escalate-ask-implement-1', '2026-01-01T00:00:05.000Z'),
        role: 'planner',
        kind: 'escalation',
        from: 'implement',
      });
      expect((await store.pendingEscalations('run-1')).map((item) => item.key)).toEqual(['escalate-ask-implement-1']);
      await store.markTaken('run-1', ['escalate-ask-implement-1']);
      expect(await store.pendingEscalations('run-1')).toEqual([]);
      await store.appendEntry('run-1', {
        ...entry('answer-1', '2026-01-01T00:00:04.000Z'),
        role: 'planner',
        kind: 'answer',
        from: 'implement',
      });
      expect((await store.answerFor('run-1', 'implement'))?.key).toBe('answer-1');
      expect(await store.answerFor('run-1', 'code-review-quality')).toBeNull();
      await store.markTaken('run-1', ['answer-1']);
      expect(await store.answerFor('run-1', 'implement')).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('stores a wait on pending entries, keeps since on a later one, clears it, and drops it when the entry is taken', async () => {
    const db = await repositoryDatabase();
    try {
      await db.app.get(RunRepository).openWaiting('run-1', '/target');
      const store = db.app.get(PlanChatStore);
      await store.appendEntry('run-1', entry('message-a', '2026-01-01T00:00:00.000Z'));
      await store.appendEntry('run-1', entry('message-b', '2026-01-01T00:00:01.000Z'));
      const wait = (since: string, retryAt: string) => ({
        on: 'model-host' as const,
        since,
        message: 'host down',
        retryAt,
      });
      await store.wait('run-1', ['message-a'], wait('2026-01-01T00:01:00.000Z', '2026-01-01T00:08:00.000Z'));
      await store.wait('run-1', ['message-a'], wait('2026-01-01T00:09:00.000Z', '2026-01-01T00:16:00.000Z'));
      let { entries } = await store.read('run-1');
      expect(entries[0].wait).toEqual(wait('2026-01-01T00:01:00.000Z', '2026-01-01T00:16:00.000Z'));
      expect(entries[1].wait).toBeUndefined();
      await store.wait('run-1', ['message-a'], null);
      expect((await store.read('run-1')).entries[0].wait).toBeUndefined();
      await store.wait('run-1', ['message-a'], wait('2026-01-01T00:01:00.000Z', '2026-01-01T00:08:00.000Z'));
      await store.markTaken('run-1', ['message-a']);
      ({ entries } = await store.read('run-1'));
      expect(entries[0]).toMatchObject({ state: 'taken' });
      expect(entries[0].wait).toBeUndefined();
    } finally {
      await db.close();
    }
  });
});
