import { FetchFailed, HttpCallDraft, PasteNeeded, SwarmloopError } from '../../swarmloop-error';
import { IssueBundle } from './issue-bundle';
import { IssueTracker } from './issue-tracker';

export abstract class AbstractIssueTracker implements IssueTracker {
  async fetch(key: string, runDir: string): Promise<{ bundle: IssueBundle; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const bundle = await this.loadIssue(key, runDir, calls);
      return { bundle, httpCalls: calls };
    } catch (error) {
      if (error instanceof PasteNeeded) {
        throw new PasteNeeded(error.url, calls);
      }
      if (error instanceof FetchFailed) {
        throw error;
      }
      if (error instanceof SwarmloopError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'issue fetch failed';
      throw new FetchFailed(message, calls);
    }
  }

  protected abstract loadIssue(key: string, runDir: string, calls: HttpCallDraft[]): Promise<IssueBundle>;
}
