import { HttpCallDraft } from '../swarmloop-error';
import { IssueBundle } from '../integrations/issue-tracker/issue-bundle';

export interface IssueTracker {
  fetch(key: string, runDir: string): Promise<{ bundle: IssueBundle; httpCalls: HttpCallDraft[] }>;
}
