import { DocumentRepository } from '../../history/document.repository';
import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { BriefingRecords, type BriefingRecord } from './briefing-record';

const sent = (decision: string): BriefingRecord => ({
  decisions: [decision],
  merged: ['b'],
  items: { tool: 'pending' },
});

async function setup() {
  const db = await repositoryDatabase();
  const run = await db.app.get(RunRepository).openWaiting('p-1', '/target');
  const documents = db.app.get(DocumentRepository);
  return { db, run, documents, records: new BriefingRecords(documents) };
}

describe('the briefing record of a subtask', () => {
  it('reads back what was written for a chat, and nothing for a chat it never saw', async () => {
    const { db, run, records } = await setup();
    try {
      await records.write(run, 'chat-1', sent('one'));

      expect(await records.read(run.key, 'chat-1')).toEqual(sent('one'));
      expect(await records.read(run.key, 'chat-2')).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('replaces the record of one chat and keeps the others', async () => {
    const { db, run, records } = await setup();
    try {
      await records.write(run, 'chat-1', sent('one'));
      await records.write(run, 'chat-2', sent('two'));
      await records.write(run, 'chat-1', { decisions: [], merged: [], items: {} });

      expect(await records.read(run.key, 'chat-1')).toEqual({ decisions: [], merged: [], items: {} });
      expect(await records.read(run.key, 'chat-2')).toEqual(sent('two'));
    } finally {
      await db.close();
    }
  });

  it('keeps every record when writes for different chats start together', async () => {
    const { db, run, records } = await setup();
    try {
      await Promise.all(['chat-1', 'chat-2', 'chat-3'].map((chat) => records.write(run, chat, sent(chat))));

      for (const chat of ['chat-1', 'chat-2', 'chat-3']) {
        expect(await records.read(run.key, chat)).toEqual(sent(chat));
      }
    } finally {
      await db.close();
    }
  });

  it('reads an unreadable document as no record', async () => {
    const { db, run, documents, records } = await setup();
    try {
      await documents.putDocument(run, 'starter_briefing', 'not json');

      expect(await records.read(run.key, 'chat-1')).toBeNull();
    } finally {
      await db.close();
    }
  });
});
