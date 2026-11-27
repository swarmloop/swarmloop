import { GitRuleRefused } from '../core/git-rule-refused';
import { FetchFailed, HostUnavailable } from '../core/swarmloop-error';
import { HOST_RETRY_MS } from '../integrations/http';
import type {
  MergeHow,
  MergeRequestDraft,
  MergeRequestQuery,
  MergeRequestRecord,
  PipelineDiagnosis,
  PipelineRef,
  SelectedHost,
} from '../integrations/code-host/code-host';
import { FakeCi } from './fake-ci';
import {
  DEFAULT_MERGE_METHODS,
  FAKE_HOST as HOST,
  WORKFLOW_FILE,
  fakeSelected,
  installOriginHook,
  mergeCommit,
  noReply,
  type Answer,
  type FakeHostSettings,
} from './fake-host-rules';
import { git } from './runs.spec-helpers';

/** A code host whose merge adds one commit to the feature branch of a real origin, with a scripted CI and an outage a spec switches on. */
export class FakeCodeHost {
  readonly name = 'gitlab';
  readonly merged = new Map<number, string>();
  readonly ci = new FakeCi();
  private readonly requests = new Map<number, MergeRequestRecord & { source: string }>();
  /** The pipelines the server asked the host to start, in order. */
  readonly nudged: PipelineRef[] = [];
  /** The runs the server asked the host to run its failed jobs of again, in order. */
  readonly reruns: { project: string; id: number }[] = [];
  /** The reason put on the request's timeline with each nudge. */
  readonly nudgeNotes: string[] = [];
  private downUntil = 0;
  private downStatus = 503;
  private retryAfterMs = HOST_RETRY_MS;
  private readonly closed = new Set<number>();
  private conflicting = false;
  private refusal: string | null = null;
  /** How many times the server asked the host to open a request, refused or not. */
  openAsks = 0;
  private mainPasses = false;
  /** The branch `readDefaultHead` reads; the feature branch unless a spec names the repository's own default. */
  private defaultBranch: string | null = null;
  private settings: FakeHostSettings = {};
  /** For each merge: the head that landed, the feature tip it landed on, and whether its CI passed on top of that tip. */
  readonly landed: { iid: number; head: string; tip: string; testedOnTop: boolean }[] = [];

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

  /** From now on the host refuses to open a request with `message`, and opens nothing. */
  refuseOpen(message: string): void {
    this.refusal = message;
  }

  /** How many merge requests were opened. */
  get opened(): number {
    return this.requests.size;
  }

  /** The CI of a commit with no script fails with `log` while the commit lacks `file`, and passes once it has it. */
  requireFile(file: string, log: string): void {
    this.ci.failUntil(log, (sha) => this.holds(sha, file));
  }

  /** A commit with no script runs CI only when it holds the host's workflow file, and then passes. */
  runsWithWorkflow(): void {
    this.ci.runsWhen((sha) => this.holds(sha, WORKFLOW_FILE));
  }

  private holds(sha: string, file: string): boolean {
    try {
      git(`${this.clone}.git`, ['cat-file', '-e', `${sha}:${file}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** The default branch reads green: every head `readDefaultHead` returns and every commit a merge makes has a passing pipeline. Nothing is scripted until a spec calls it. */
  defaultBranchPasses(): void {
    this.mainPasses = true;
  }

  /** The default branch of the repository is `name`, not the feature branch: its head is what main reads as. */
  defaultBranchIs(name: string): void {
    this.defaultBranch = name;
  }

  /** The request is closed without a merge, as a person does on the host. */
  closeRequest(iid: number): void {
    this.closed.add(iid);
  }

  /** Every request has a merge conflict with its base, until it is switched off. A request also conflicts when its branch does not merge with the feature branch in git. */
  conflicts(on: boolean): void {
    this.conflicting = on;
  }

  /** Sets what the host allows and answers; a setting a call leaves out stays as it was. */
  configure(settings: FakeHostSettings): void {
    this.settings = { ...this.settings, ...settings };
    if (settings.origin) installOriginHook(`${this.clone}.git`, this.feature, settings.origin);
  }

  selected(): SelectedHost {
    return fakeSelected();
  }

  readMergeMethods(): Answer<'readMergeMethods'> {
    this.guard();
    return Promise.resolve({ methods: [...(this.settings.mergeMethods ?? DEFAULT_MERGE_METHODS)], httpCalls: [] });
  }

  readAuthor(login: string): Answer<'readAuthor'> {
    this.guard();
    const { author } = this.settings;
    const answer = author === 'none' ? { name: null, email: null } : (author ?? noReply(login));
    return Promise.resolve({ ...answer, httpCalls: [] });
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
    this.openAsks += 1;
    if (this.refusal) {
      return Promise.reject(new FetchFailed(this.refusal));
    }
    const rule = this.settings.title;
    if (rule && !new RegExp(rule.pattern).test(draft.title)) {
      return Promise.reject(new GitRuleRefused(rule.message, draft.title, 'title'));
    }
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
      conflicts: this.conflicting || this.mergeTree(iid) === null,
      draft: this.requests.get(iid)?.draft ?? false,
      httpCalls: [],
    });
  }

  readMergeGate(_project: string, iid: number): Answer<'readMergeGate'> {
    this.guard();
    const sha = this.merged.get(iid) ?? null;
    const source = this.requests.get(iid)?.source;
    return Promise.resolve({
      state: sha ? 'merged' : this.closed.has(iid) ? 'closed' : 'open',
      sha,
      draft: this.requests.get(iid)?.draft ?? false,
      head: source && this.onOrigin(source) ? git(this.clone, ['rev-parse', `origin/${source}`]) : '',
      mergeability: this.conflicting || this.mergeTree(iid) === null ? 'conflicting' : 'clean',
      blockedBy: null,
      httpCalls: [],
    });
  }

  readDefaultHead(): Answer<'readDefaultHead'> {
    this.guard();
    this.fetchWhenReachable();
    const branch = this.defaultBranch ?? this.feature;
    const sha = git(this.clone, ['rev-parse', `origin/${branch}`]);
    if (this.mainPasses) this.ci.pass(sha);
    return Promise.resolve({ branch, sha, httpCalls: [] });
  }

  readBranchHead(ref: PipelineRef): Answer<'readBranchHead'> {
    this.guard();
    return Promise.resolve({ sha: this.originHead(ref.ref) ?? ref.sha ?? '', httpCalls: [] });
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

  /**
   * The merge adds a commit to the feature branch, by squash unless `how` says another method the repository allows.
   * It has the tree of the request's branch merged onto the feature tip, as a squash merge has; a request whose
   * branch is not on origin merges the tip's own tree.
   */
  mergeMergeRequest(_project: string, iid: number, _head?: string, how?: MergeHow): Answer<'mergeMergeRequest'> {
    this.guard();
    const method = how?.method ?? 'squash';
    if (!(this.settings.mergeMethods ?? DEFAULT_MERGE_METHODS).includes(method)) {
      return Promise.reject(new FetchFailed(`the repository does not allow a ${method} merge`));
    }
    git(this.clone, ['fetch', 'origin']);
    const tip = git(this.clone, ['rev-parse', `origin/${this.feature}`]);
    const tree = this.mergeTree(iid) ?? git(this.clone, ['rev-parse', `${tip}^{tree}`]);
    const source = this.requests.get(iid)?.source;
    const head = source && this.onOrigin(source) ? git(this.clone, ['rev-parse', `origin/${source}`]) : null;
    const sha = mergeCommit(this.clone, method, iid, tip, head, tree, how?.title);
    git(this.clone, ['push', 'origin', `${sha}:refs/heads/${this.feature}`]);
    this.merged.set(iid, sha);
    if (this.mainPasses) this.ci.pass(sha);
    this.recordLanding(iid, tip);
    return Promise.resolve({ sha, httpCalls: [] });
  }

  /** The tree of the request's branch merged onto the feature tip. The tip's tree when the branch is not on origin, null on a conflict. */
  private mergeTree(iid: number): string | null {
    const source = this.requests.get(iid)?.source;
    if (!source || !this.onOrigin(source)) return git(this.clone, ['rev-parse', `origin/${this.feature}^{tree}`]);
    try {
      return git(this.clone, ['merge-tree', '--write-tree', `origin/${this.feature}`, `origin/${source}`]);
    } catch {
      return null;
    }
  }

  /** A fetch of origin for a read of its head. The origin of a spec may name a host that nothing answers: the refs already known are read then. */
  private fetchWhenReachable(): void {
    try {
      git(this.clone, ['fetch', 'origin']);
    } catch {
      // Unreachable origin: the known refs stand.
    }
  }

  /** The last known head of a branch on origin, or null when origin has no such branch. No fetch: the origin of a spec may name a host that nothing answers. */
  private originHead(branch: string): string | null {
    try {
      return git(this.clone, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
    } catch {
      return null;
    }
  }

  private onOrigin(branch: string): boolean {
    git(this.clone, ['fetch', 'origin']);
    try {
      git(this.clone, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private recordLanding(iid: number, tip: string): void {
    const source = this.requests.get(iid)?.source;
    if (!source || !this.onOrigin(source)) return;
    const head = git(this.clone, ['rev-parse', `origin/${source}`]);
    let testedOnTop = true;
    try {
      git(this.clone, ['merge-base', '--is-ancestor', tip, head]);
    } catch {
      testedOnTop = false;
    }
    this.landed.push({ iid, head, tip, testedOnTop: testedOnTop && this.ci.passed(head, source) });
  }

  closeMergeRequest(): Answer<'closeMergeRequest'> {
    this.guard();
    return Promise.resolve({ httpCalls: [] });
  }

  deleteBranch(): Answer<'deleteBranch'> {
    this.guard();
    return Promise.resolve({ httpCalls: [] });
  }

  readBranchPipeline(ref: { sha?: string; ref?: string }): Answer<'readBranchPipeline'> {
    this.guard();
    return Promise.resolve({ snapshot: this.ci.snapshot(ref.sha, ref.ref), httpCalls: [] });
  }

  readBranchHasPipeline(ref: { ref?: string }): Answer<'readBranchHasPipeline'> {
    this.guard();
    return Promise.resolve({ found: this.ci.snapshot(undefined, ref.ref) !== null, httpCalls: [] });
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

  startPipeline(ref: PipelineRef, reason: string): Answer<'startPipeline'> {
    this.guard();
    this.nudged.push(ref);
    this.nudgeNotes.push(reason);
    this.ci.nudge(ref.sha);
    return Promise.resolve({ httpCalls: [] });
  }

  readJobTrace(): Answer<'readJobTrace'> {
    this.guard();
    return Promise.resolve({ trace: this.ci.trace(), httpCalls: [] });
  }

  rerunFailedJobs(project: string, id: number): Answer<'rerunFailedJobs'> {
    this.guard();
    this.reruns.push({ project, id });
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
