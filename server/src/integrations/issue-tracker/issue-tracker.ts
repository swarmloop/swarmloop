import type { HttpCallDraft } from '../../core/swarmloop-error';
import type { IssueBundle } from './issue-bundle';

export interface IssueTracker {
  fetch(key: string, runDir: string): Promise<{ bundle: IssueBundle; httpCalls: HttpCallDraft[] }>;
}
