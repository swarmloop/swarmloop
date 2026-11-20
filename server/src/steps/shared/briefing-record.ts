import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { ARTIFACTS } from '../contract/artifacts';

/** What one chat of a subtask was already told of its starter's state. */
export interface BriefingRecord {
  /** The decision lines sent. */
  decisions: string[];
  /** The merged dependencies sent. */
  merged: string[];
  /** The status of each sibling's contract item as it was sent, by item id. */
  items: Record<string, string>;
}

type Records = Record<string, BriefingRecord>;

/** The per-chat record in a run's `starter_briefing` document. Writes of one run go one after another. */
export class BriefingRecords {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly documents: DocumentRepository) {}

  /** The record of a chat, or null when none was kept: the chat was never told, or the document is unreadable. */
  async read(key: string, chatId: string): Promise<BriefingRecord | null> {
    return (await this.all(key))[chatId] ?? null;
  }

  /** Sets the record of one chat, replacing the one it had, and keeps the records of the other chats. */
  async write(run: RunEntity, chatId: string, record: BriefingRecord): Promise<void> {
    const before = this.tails.get(run.key) ?? Promise.resolve();
    const turn = before.then(async () => {
      const records = await this.all(run.key);
      await this.documents.putDocument(
        run,
        ARTIFACTS.starterBriefing.kind,
        JSON.stringify({ ...records, [chatId]: record }),
      );
    });
    const tail = turn.catch(() => undefined);
    this.tails.set(run.key, tail);
    try {
      await turn;
    } finally {
      if (this.tails.get(run.key) === tail) this.tails.delete(run.key);
    }
  }

  private async all(key: string): Promise<Records> {
    const body = await this.documents.latestBody(key, ARTIFACTS.starterBriefing.kind);
    try {
      const parsed: unknown = body ? JSON.parse(body) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Records) : {};
    } catch {
      return {};
    }
  }
}
