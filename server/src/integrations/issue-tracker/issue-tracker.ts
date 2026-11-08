import type { HttpCallDraft } from '../../core/swarmloop-error';
import type { IssueBundle } from './issue-bundle';

export interface IssueTracker {
  /** The ticket keys this tracker recognizes in plain text. Without a configured tracker, none. */
  ticketKeys(text: string): Promise<string[]>;
  fetch(key: string, runDir: string): Promise<{ bundle: IssueBundle; httpCalls: HttpCallDraft[] }>;
}

/** A run id typed as a Jira key keeps that meaning, whatever the text says. */
function isKeyShaped(runId: string): boolean {
  return /^[A-Z][A-Z0-9]+-\d+$/.test(runId);
}

/** The keys a run fetches: the typed run id when it is a key, plus what the tracker finds in the text. */
export async function runKeys(tracker: IssueTracker, runId: string, text: string): Promise<string[]> {
  const typed = isKeyShaped(runId) ? [runId] : [];
  return [...new Set([...typed, ...(await tracker.ticketKeys(text))])];
}
