import type {
  CodeHost,
  MergeRequestDraft,
  MergeRequestQuery,
  MergeRequestRecord,
  PipelineJob,
  PipelineRef,
  PipelineSnapshot,
} from '../integrations/code-host/code-host';
import { git } from './runs.spec-helpers';

/** What a call of the fake host answers instead of its normal answer: an HTTP status or a network error. */
type HostFault = { status: number; stored?: boolean } | { network: true };

type Answer<M extends keyof CodeHost> = Required<CodeHost>[M] extends (...args: never[]) => infer R ? R : never;

interface HostCall {
  method: string;
  args: unknown[];
}

/** A code host whose merge adds one commit to the feature branch of a real origin. It also has CI and faults, both off until a spec sets them. */
export class FakeCodeHost {
  readonly merged = new Map<number, string>();
  /** Every call, in order, as plain data. */
  readonly calls: HostCall[] = [];
  /** The merge requests this host made, by source branch. */
  readonly requests = new Map<string, MergeRequestRecord>();
  private jobs: PipelineJob[] = [];
  private rerunStatus = 'success';
  private readonly faults = new Map<string, HostFault[]>();

  constructor(
    private readonly clone: string,
    private readonly feature: string,
  ) {}

  /** The next `times` calls of `method` answer the fault. A `stored` status on a create keeps what the call made. */
  fail(method: string, fault: HostFault, times = 1): void {
    this.faults.set(method, [...(this.faults.get(method) ?? []), ...Array.from({ length: times }, () => fault)]);
  }

  /** The jobs of the head commit. A rerun moves each failed job to `rerunStatus`. */
  setJobs(jobs: PipelineJob[], rerunStatus = 'success'): void {
    this.jobs = jobs;
    this.rerunStatus = rerunStatus;
  }

  findMergeRequest(query: MergeRequestQuery): Answer<'findMergeRequest'> {
    this.enter('findMergeRequest', [query]);
    return Promise.resolve({ record: this.requests.get(query.source) ?? null, httpCalls: [] });
  }

  openMergeRequest(draft: MergeRequestDraft): Answer<'openMergeRequest'> {
    const fault = this.enter('openMergeRequest', [draft], true);
    const record = this.requests.get(draft.source) ?? {
      project: draft.project,
      iid: this.requests.size + 1,
      url: `https://code.example/${draft.project}/${this.requests.size + 1}`,
      summary: draft.summary,
      draft: draft.draft,
    };
    if (fault && !('status' in fault && fault.stored)) throw this.error(fault);
    this.requests.set(draft.source, record);
    if (fault) throw this.error(fault);
    return Promise.resolve({ record, draftsUnavailable: false, httpCalls: [] });
  }

  readMergeRequest(
    _project: string,
    iid: number,
  ): Promise<{ state: 'open' | 'merged'; sha: string | null; conflicts: boolean; httpCalls: [] }> {
    this.enter('readMergeRequest', [iid]);
    const sha = this.merged.get(iid) ?? null;
    return Promise.resolve({ state: sha ? 'merged' : 'open', sha, conflicts: false, httpCalls: [] });
  }

  mergeMergeRequest(_project: string, iid: number): Answer<'mergeMergeRequest'> {
    this.enter('mergeMergeRequest', [iid]);
    git(this.clone, ['fetch', 'origin']);
    const tip = git(this.clone, ['rev-parse', `origin/${this.feature}`]);
    const tree = git(this.clone, ['rev-parse', `${tip}^{tree}`]);
    const sha = git(this.clone, ['commit-tree', tree, '-p', tip, '-m', `squash !${iid}`]);
    git(this.clone, ['push', 'origin', `${sha}:refs/heads/${this.feature}`]);
    this.merged.set(iid, sha);
    return Promise.resolve({ sha, httpCalls: [] });
  }

  closeMergeRequest(): Answer<'closeMergeRequest'> {
    this.enter('closeMergeRequest', []);
    return Promise.resolve({ httpCalls: [] });
  }

  deleteBranch(): Answer<'deleteBranch'> {
    this.enter('deleteBranch', []);
    return Promise.resolve({ httpCalls: [] });
  }

  readBranchPipeline(ref: PipelineRef): Answer<'readBranchPipeline'> {
    this.enter('readBranchPipeline', [ref]);
    const failed = this.jobs.some((job) => job.status === 'failed');
    const status = failed ? 'failed' : this.jobs.some((job) => job.status === 'running') ? 'running' : 'success';
    const snapshot: PipelineSnapshot = {
      id: 1,
      status,
      url: 'https://code.example/pipelines/1',
      jobs: this.jobs,
      runs: [],
      checks: [],
      awaiting: [],
    };
    return Promise.resolve({ snapshot: this.jobs.length > 0 ? snapshot : null, httpCalls: [] });
  }

  rerunFailedJobs(project: string, id: number): Answer<'rerunFailedJobs'> {
    this.enter('rerunFailedJobs', [project, id]);
    this.jobs = this.jobs.map((job) => (job.status === 'failed' ? { ...job, status: this.rerunStatus } : job));
    return Promise.resolve({ httpCalls: [] });
  }

  /** Logs the call and throws its fault. A create asks for the fault back, to decide what it stores first. */
  private enter(method: string, args: unknown[], keep = false): HostFault | undefined {
    this.calls.push({ method, args });
    const fault = this.faults.get(method)?.shift();
    if (fault && !keep) throw this.error(fault);
    return fault;
  }

  private error(fault: HostFault): Error {
    return new Error('network' in fault ? 'fetch failed' : `HTTP ${fault.status} for https://code.example`);
  }
}
