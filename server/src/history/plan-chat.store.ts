import { Injectable, NotFoundException } from '@nestjs/common';
import {
  PLAN_CHAT_KIND,
  readPlanChat,
  type PlanChatEntry,
  type PlanChatLog,
  type PlanChatWait,
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

  /** The person's messages that wait for the planner, oldest first. */
  async pending(key: string): Promise<PlanChatEntry[]> {
    const { entries } = await this.read(key);
    return entries
      .filter((entry) => entry.role === 'person' && entry.state === 'pending')
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  /** The questions of steps that wait for the planner, oldest first. */
  async pendingQuestions(key: string): Promise<PlanChatEntry[]> {
    const { entries } = await this.read(key);
    return entries
      .filter((entry) => entry.kind === 'question' && entry.state === 'pending')
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  /** The questions the planner escalated that wait for the person's answer, oldest first. */
  async pendingEscalations(key: string): Promise<PlanChatEntry[]> {
    const { entries } = await this.read(key);
    return entries
      .filter((entry) => entry.kind === 'escalation' && entry.state === 'pending')
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  /** The planner's answer to the step's question that the step did not read yet, if there is one. */
  async answerFor(key: string, step: string): Promise<PlanChatEntry | null> {
    const { entries } = await this.read(key);
    return entries.find((entry) => entry.kind === 'answer' && entry.from === step && entry.state === 'pending') ?? null;
  }

  /** Marks the entries with these keys as taken. A taken or unknown key is left alone, and nothing is written for none. */
  markTaken(key: string, entryKeys: readonly string[]): Promise<void> {
    return this.change(key, (log) =>
      log.entries.some((entry) => entry.state === 'pending' && entryKeys.includes(entry.key))
        ? {
            ...log,
            entries: log.entries.map((entry) => {
              if (entry.state !== 'pending' || !entryKeys.includes(entry.key)) return entry;
              const { wait: _dropped, ...taken } = entry;
              return { ...taken, state: 'taken' };
            }),
          }
        : log,
    );
  }

  /**
   * Sets the wait of the pending entries with these keys, or clears it with null. A wait already there keeps its
   * `since`; a later outage replaces its message and next try. Nothing is written when nothing changes.
   */
  wait(key: string, entryKeys: readonly string[], wait: PlanChatWait | null): Promise<void> {
    const marked = (entry: PlanChatEntry): boolean => entry.state === 'pending' && entryKeys.includes(entry.key);
    const next = (entry: PlanChatEntry): PlanChatEntry => {
      if (!marked(entry)) return entry;
      if (!wait) {
        const { wait: _cleared, ...rest } = entry;
        return rest;
      }
      return { ...entry, wait: { ...wait, since: entry.wait?.since ?? wait.since } };
    };
    return this.change(key, (log) => {
      const entries = log.entries.map(next);
      return JSON.stringify(entries) === JSON.stringify(log.entries) ? log : { ...log, entries };
    });
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
