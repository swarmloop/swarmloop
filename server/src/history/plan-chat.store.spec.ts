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
});
