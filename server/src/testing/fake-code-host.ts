import { HostUnavailable } from '../core/swarmloop-error';
import { HOST_RETRY_MS } from '../integrations/http';
import type {
  CodeHost,
  MergeRequestDraft,
  MergeRequestQuery,
  MergeRequestRecord,
  SelectedHost,
} from '../integrations/code-host/code-host';
import { FakeCi } from './fake-ci';
import { git } from './runs.spec-helpers';

type Answer<M extends keyof CodeHost> = Required<CodeHost>[M] extends (...args: never[]) => infer R ? R : never;

const HOST = 'gitlab.example';

/** A code host whose merge adds one commit to the feature branch of a real origin, with a scripted CI and an outage a spec switches on. */
export class FakeCodeHost {
  readonly name = 'gitlab';
  readonly merged = new Map<number, string>();
  readonly ci = new FakeCi();
  private readonly requests = new Map<number, MergeRequestRecord & { source: string }>();
  private downUntil = 0;
  private downStatus = 503;
  private retryAfterMs = HOST_RETRY_MS;

  constructor(
    private readonly clone: string,
    private readonly feature: string,
    private readonly now: () => number,
  ) {}

  /** Every call fails with `HTTP <status>` until `ms` have passed on the injected clock, and changes nothing. The next try is `retryAfterMs` after a failure, as a `Retry-After` header advises. */
  hostDown(ms: number, status = 503, retryAfterMs = HOST_RETRY_MS): void {
    this.downUntil = this.now() + ms;
    this.downStatus = status;
    this.retryAfterMs = retryAfterMs;
  }

  selected(): SelectedHost {
    return {
      name: 'gitlab',
      baseUrl: `https://${HOST}`,
      token: 'token',
      baseKey: 'GITLAB_BASE_URL',
      tokenKey: 'GITLAB_TOKEN',
    };
  }

  matchesOrigin(origin: string): boolean {
    return origin.includes(HOST);
  }

  pushUrl(origin: string): string | null {
    return this.matchesOrigin(origin) ? origin.replace('https://', 'https://oauth2:token@') : null;
  }

  findMergeRequest(query: MergeRequestQuery): Answer<'findMergeRequest'> {
    this.guard();
    const found = [...this.requests.values()].find((item) => item.source === query.source);
    return Promise.resolve({ record: found ? this.record(found) : null, httpCalls: [] });
  }

  openMergeRequest(draft: MergeRequestDraft): Answer<'openMergeRequest'> {
    this.guard();
    const iid = this.requests.size + 1;
    const record = {
      project: draft.project,
      iid,
      url: `https://${HOST}/${draft.project}/-/merge_requests/${iid}`,
      summary: draft.summary,
      draft: draft.draft,
      source: draft.source,
    };
    this.requests.set(iid, record);
    return Promise.resolve({ record: this.record(record), draftsUnavailable: false, httpCalls: [] });
  }

  setDraft(_project: string, iid: number, draft: boolean): Answer<'setDraft'> {
    this.guard();
    this.request(iid).draft = draft;
    return Promise.resolve({ httpCalls: [] });
  }

  updateMergeRequest(_project: string, iid: number, summary: string): Answer<'updateMergeRequest'> {
    this.guard();
    this.request(iid).summary = summary;
    return Promise.resolve({ httpCalls: [] });
  }

  readMergeRequest(
    _project: string,
    iid: number,
  ): Promise<{ state: 'open' | 'merged'; sha: string | null; conflicts: boolean; draft: boolean; httpCalls: [] }> {
    this.guard();
    const sha = this.merged.get(iid) ?? null;
    return Promise.resolve({
      state: sha ? 'merged' : 'open',
      sha,
      conflicts: false,
      draft: this.requests.get(iid)?.draft ?? false,
      httpCalls: [],
    });
  }

  mergeRequestState(_project: string, iid: number): Answer<'mergeRequestState'> {
    this.guard();
    const sha = this.merged.get(iid);
    const at = new Date(this.now()).toISOString();
    return Promise.resolve({ ...(sha ? { state: 'merged', sha, by: null, at } : { state: 'open' }), httpCalls: [] });
  }

  mergeMergeRequest(_project: string, iid: number): Answer<'mergeMergeRequest'> {
    this.guard();
    git(this.clone, ['fetch', 'origin']);
    const tip = git(this.clone, ['rev-parse', `origin/${this.feature}`]);
    const tree = git(this.clone, ['rev-parse', `${tip}^{tree}`]);
    const sha = git(this.clone, ['commit-tree', tree, '-p', tip, '-m', `squash !${iid}`]);
    git(this.clone, ['push', 'origin', `${sha}:refs/heads/${this.feature}`]);
    this.merged.set(iid, sha);
    return Promise.resolve({ sha, httpCalls: [] });
  }

  closeMergeRequest(): Answer<'closeMergeRequest'> {
    this.guard();
    return Promise.resolve({ httpCalls: [] });
  }

  deleteBranch(): Answer<'deleteBranch'> {
    this.guard();
    return Promise.resolve({ httpCalls: [] });
  }

  readBranchPipeline(ref: { sha?: string }): Answer<'readBranchPipeline'> {
    this.guard();
    return Promise.resolve({ snapshot: this.ci.snapshot(ref.sha), httpCalls: [] });
  }

  readJobTrace(): Answer<'readJobTrace'> {
    this.guard();
    return Promise.resolve({ trace: this.ci.trace(), httpCalls: [] });
  }

  rerunFailedJobs(): Answer<'rerunFailedJobs'> {
    this.guard();
    return Promise.resolve({ httpCalls: [] });
  }

  cancelPipeline(): Answer<'cancelPipeline'> {
    this.guard();
    return Promise.resolve({ httpCalls: [] });
  }

  readRunNotes(): Answer<'readRunNotes'> {
    this.guard();
    return Promise.resolve({ notes: '', httpCalls: [] });
  }

  private guard(): void {
    if (this.now() < this.downUntil) {
      throw new HostUnavailable(
        HOST,
        `HTTP ${this.downStatus}`,
        new Date(this.now() + this.retryAfterMs).toISOString(),
      );
    }
  }

  private request(iid: number): MergeRequestRecord {
    const found = this.requests.get(iid);
    if (!found) {
      throw new Error(`merge request !${iid} is missing`);
    }
    return found;
  }

  private record({ source: _source, ...record }: MergeRequestRecord & { source: string }): MergeRequestRecord {
    return record;
  }
}
