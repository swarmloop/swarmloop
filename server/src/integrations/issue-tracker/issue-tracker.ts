import { HttpCallDraft } from '../../core/swarmloop-error';
import { IssueBundle } from './issue-bundle';

export interface IssueTracker {
  fetch(key: string, runDir: string): Promise<{ bundle: IssueBundle; httpCalls: HttpCallDraft[] }>;
}
