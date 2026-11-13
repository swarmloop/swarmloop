import { HostUnavailable } from '../core/swarmloop-error';
import { HOST_RETRY_MS } from '../integrations/http';
import type {
  CodeHost,
  MergeRequestDraft,
  MergeRequestQuery,
  MergeRequestRecord,
  PipelineDiagnosis,
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
  private readonly closed = new Set<number>();
  private conflicting = false;

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

  /** How many merge requests were opened. */
  get opened(): number {
    return this.requests.size;
  }

  /** The request is closed without a merge, as a person does on the host. */
  closeRequest(iid: number): void {
    this.closed.add(iid);
  }

  /** Every request has a merge conflict with its base, until it is switched off. */
  conflicts(on: boolean): void {
    this.conflicting = on;
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
  ): Promise<{
    state: 'open' | 'merged' | 'closed';
    sha: string | null;
    conflicts: boolean;
    draft: boolean;
    httpCalls: [];
  }> {
    this.guard();
    const sha = this.merged.get(iid) ?? null;
    return Promise.resolve({
      state: sha ? 'merged' : this.closed.has(iid) ? 'closed' : 'open',
      sha,
      conflicts: this.conflicting,
      draft: this.requests.get(iid)?.draft ?? false,
      httpCalls: [],
    });
  }

  mergeRequestState(_project: string, iid: number): Answer<'mergeRequestState'> {
    this.guard();
    const sha = this.merged.get(iid);
    const at = new Date(this.now()).toISOString();
    const state = sha
      ? { state: 'merged' as const, sha, by: null, at }
      : this.closed.has(iid)
        ? { state: 'closed' as const, by: null, at }
        : { state: 'open' as const };
    return Promise.resolve({ ...state, httpCalls: [] });
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

  /** What a host says when no run started: a closed request or a merge conflict, else nothing. */
  diagnoseMissingPipeline(): Promise<PipelineDiagnosis> {
    this.guard();
    const code = [...this.requests.keys()].some((iid) => this.closed.has(iid))
      ? 'closed'
      : this.conflicting
        ? 'merge-conflict'
        : undefined;
    const reason = code === 'closed' ? 'merge request is closed' : 'merge request has a conflict';
    return Promise.resolve(code ? { reason, code, httpCalls: [] } : { reason: null, httpCalls: [] });
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
    return Promise.resolve({ notes: this.ci.notes, httpCalls: [] });
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
