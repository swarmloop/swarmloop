import type { CodeHost, MergeRequestQuery } from '../integrations/code-host/code-host';
import { git } from './runs.spec-helpers';

type Answer<M extends keyof CodeHost> = Required<CodeHost>[M] extends (...args: never[]) => infer R ? R : never;

/** A code host whose merge adds one commit to the feature branch of a real origin. */
export class FakeCodeHost {
  readonly merged = new Map<number, string>();

  constructor(
    private readonly clone: string,
    private readonly feature: string,
  ) {}

  findMergeRequest(_query: MergeRequestQuery): Answer<'findMergeRequest'> {
    return Promise.resolve({ record: null, httpCalls: [] });
  }

  readMergeRequest(
    _project: string,
    iid: number,
  ): Promise<{ state: 'open' | 'merged'; sha: string | null; conflicts: boolean; httpCalls: [] }> {
    const sha = this.merged.get(iid) ?? null;
    return Promise.resolve({ state: sha ? 'merged' : 'open', sha, conflicts: false, httpCalls: [] });
  }

  mergeMergeRequest(_project: string, iid: number): Answer<'mergeMergeRequest'> {
    git(this.clone, ['fetch', 'origin']);
    const tip = git(this.clone, ['rev-parse', `origin/${this.feature}`]);
    const tree = git(this.clone, ['rev-parse', `${tip}^{tree}`]);
    const sha = git(this.clone, ['commit-tree', tree, '-p', tip, '-m', `squash !${iid}`]);
    git(this.clone, ['push', 'origin', `${sha}:refs/heads/${this.feature}`]);
    this.merged.set(iid, sha);
    return Promise.resolve({ sha, httpCalls: [] });
  }

  closeMergeRequest(): Answer<'closeMergeRequest'> {
    return Promise.resolve({ httpCalls: [] });
  }

  deleteBranch(): Answer<'deleteBranch'> {
    return Promise.resolve({ httpCalls: [] });
  }
}
