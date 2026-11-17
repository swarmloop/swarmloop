import { Injectable, NotFoundException } from '@nestjs/common';
import {
  PLAN_CHAT_KIND,
  readPlanChat,
  type PlanChatEntry,
  type PlanChatLog,
  type PlanRevision,
} from '../contract/plan-chat';
import { DocumentRepository } from './document.repository';
import { RunRepository } from './run.repository';

/** The plan chat of a run: its entries and plan revisions, written one after another per run. */
@Injectable()
export class PlanChatStore {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
  ) {}

  async read(key: string): Promise<PlanChatLog> {
    return readPlanChat(await this.documents.latestBody(key, PLAN_CHAT_KIND));
  }

  /** Adds the entry at the end. An entry with a known key is written once. */
  appendEntry(key: string, entry: PlanChatEntry): Promise<void> {
    return this.change(key, (log) =>
      log.entries.some((known) => known.key === entry.key) ? log : { ...log, entries: [...log.entries, entry] },
    );
  }

  /** Adds the revision at the end. A version that is already there is written once. */
  appendRevision(key: string, revision: PlanRevision): Promise<void> {
    return this.change(key, (log) =>
      log.revisions.some((known) => known.version === revision.version)
        ? log
        : { ...log, revisions: [...log.revisions, revision] },
    );
  }

  /** Runs after every earlier change of the same run, and ends before the returned promise does. */
  private change(key: string, edit: (log: PlanChatLog) => PlanChatLog): Promise<void> {
    const run = (this.tails.get(key) ?? Promise.resolve()).then(async () => {
      const found = await this.runs.findRun(key);
      if (!found) {
        throw new NotFoundException(`${key} is missing`);
      }
      const log = edit(await this.read(key));
      await this.documents.putDocument(found, PLAN_CHAT_KIND, `${JSON.stringify(log)}\n`);
    });
    const tail = run.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }
}
