import { FetchFailed, HostUnavailable, MergeConflict, SwarmloopError } from '../core/swarmloop-error';
import type {
  CodeHost,
  MergeGate,
  MergeRequestQuery,
  MergeRequestRecord,
  MergeRequestState,
  MergeRequestView,
  PipelineCheck,
  PipelineRef,
  PipelineSnapshot,
  SelectedHost,
} from '../integrations/code-host/code-host';
import type { HttpCallDraft } from '../core/swarmloop-error';

const DOMAIN = 'backlog.example';

interface FakeProject {
  branch: string;
  head: string;
  /** The pipeline per commit: a commit with none has no entry. */
  pipelines: Map<string, PipelineSnapshot>;
  merges: number;
}

interface FakeRequest {
  gate: MergeGate;
  checks: PipelineCheck[];
  refusal: string | null;
  conflict: string | null;
}

interface FakeBacklogCall {
  name: string;
  args: unknown[];
}

function unsupported(): never {
  throw new SwarmloopError('the fake backlog host does not serve this call');
}

/** Scripted state of the default branch pipeline that a spec gives to `setPipeline`. */
export function pipelineOf(status: string, checks: PipelineCheck[] = [], url = ''): PipelineSnapshot {
  return { id: 1, status, url, jobs: [], runs: [], checks, awaiting: [] };
}

/** An in-memory code host for the backlog specs: several projects on one fake domain, scripted by the spec. */
export class FakeBacklogHost implements CodeHost {
  readonly name = 'backlog-fake';
  readonly label = 'Backlog fake';
  readonly ciFiles: readonly string[] = [];
  /** Every call that reached the host, in order. */
  readonly calls: FakeBacklogCall[] = [];
  private readonly projects = new Map<string, FakeProject>();
  private readonly requests = new Map<string, FakeRequest>();
  private outageAt: string | null = null;
  private trace = '';

  /** The url of a project on this host's domain, for a checkout's origin. */
  static originOf(project: string): string {
    return `https://${DOMAIN}/${project}.git`;
  }

  addProject(project: string, branch = 'main', head = `${project}-head-0`): void {
    this.projects.set(project, { branch, head, pipelines: new Map(), merges: 0 });
  }

  setHead(project: string, head: string): void {
    this.project(project).head = head;
  }

  /** The pipeline of the project's current head. */
  setPipeline(project: string, snapshot: PipelineSnapshot | null): void {
    const found = this.project(project);
    if (snapshot) found.pipelines.set(found.head, snapshot);
    else found.pipelines.delete(found.head);
  }

  headOf(project: string): string {
    return this.project(project).head;
  }

  setGate(project: string, iid: number, gate: Partial<MergeGate>): void {
    const request = this.request(project, iid);
    request.gate = { ...request.gate, ...gate };
  }

  setChecks(project: string, iid: number, checks: PipelineCheck[]): void {
    this.request(project, iid).checks = checks;
  }

  refuseMerge(project: string, iid: number, message: string | null): void {
    this.request(project, iid).refusal = message;
  }

  conflictMerge(project: string, iid: number, message: string | null): void {
    this.request(project, iid).conflict = message;
  }

  /** Every call after this throws `HostUnavailable`. */
  hostDown(retryAt: string | null): void {
    this.outageAt = retryAt;
  }

  matchesOrigin(origin: string): boolean {
    return origin.startsWith(`https://${DOMAIN}/`);
  }

  async readDefaultHead(project: string): Promise<{ branch: string; sha: string; httpCalls: HttpCallDraft[] }> {
    await this.record('readDefaultHead', project);
    const { branch, head } = this.project(project);
    return { branch, sha: head, httpCalls: [] };
  }

  /** The log a spec gives to `setTrace`, whatever the job. */
  async readJobTrace(project: string, jobId: number): Promise<{ trace: string; httpCalls: HttpCallDraft[] }> {
    await this.record('readJobTrace', { project, jobId });
    return { trace: this.trace, httpCalls: [] };
  }

  setTrace(trace: string): void {
    this.trace = trace;
  }

  async readBranchHead(ref: PipelineRef): Promise<{ sha: string; httpCalls: HttpCallDraft[] }> {
    await this.record('readBranchHead', ref);
    return { sha: ref.sha ?? '', httpCalls: [] };
  }

  async readBranchPipeline(
    ref: PipelineRef,
  ): Promise<{ snapshot: PipelineSnapshot | null; httpCalls: HttpCallDraft[] }> {
    await this.record('readBranchPipeline', ref);
    const project = this.project(ref.project);
    const request = [...this.requests.entries()].find(
      ([key, found]) => key.startsWith(`${ref.project}#`) && found.gate.head === ref.sha,
    )?.[1];
    if (request) {
      return { snapshot: { ...pipelineOf('running'), checks: request.checks }, httpCalls: [] };
    }
    return { snapshot: project.pipelines.get(ref.sha ?? project.head) ?? null, httpCalls: [] };
  }

  async readMergeGate(project: string, iid: number): Promise<MergeGate & { httpCalls: HttpCallDraft[] }> {
    await this.record('readMergeGate', project, iid);
    return { ...this.request(project, iid).gate, httpCalls: [] };
  }

  async mergeMergeRequest(
    project: string,
    iid: number,
    head?: string,
  ): Promise<{ sha: string; httpCalls: HttpCallDraft[] }> {
    await this.record('mergeMergeRequest', project, iid, head);
    const request = this.request(project, iid);
    if (request.conflict !== null) throw new MergeConflict(request.conflict);
    if (request.refusal !== null) throw new FetchFailed(request.refusal);
    const found = this.project(project);
    found.merges += 1;
    const sha = `${project}-merge-${found.merges}`;
    found.head = sha;
    request.gate = { ...request.gate, state: 'merged', sha };
    return { sha, httpCalls: [] };
  }

  async mergeRequestState(project: string, iid: number): Promise<MergeRequestState & { httpCalls: HttpCallDraft[] }> {
    await this.record('mergeRequestState', project, iid);
    const { state, sha } = this.request(project, iid).gate;
    if (state === 'merged') return { state, sha, by: null, at: '', httpCalls: [] };
    return state === 'closed' ? { state, by: null, at: '', httpCalls: [] } : { state, httpCalls: [] };
  }

  async findMergeRequest(
    query: MergeRequestQuery,
  ): Promise<{ record: MergeRequestRecord | null; httpCalls: HttpCallDraft[] }> {
    await this.record('findMergeRequest', query);
    return { record: null, httpCalls: [] };
  }

  private record(name: string, ...args: unknown[]): Promise<void> {
    this.calls.push({ name, args });
    return this.outageAt === null
      ? Promise.resolve()
      : Promise.reject(new HostUnavailable(this.name, 'HTTP 503', this.outageAt));
  }

  private project(project: string): FakeProject {
    const found = this.projects.get(project);
    if (!found) throw new FetchFailed(`${project} is not on the fake backlog host`);
    return found;
  }

  private request(project: string, iid: number): FakeRequest {
    const key = `${project}#${iid}`;
    let found = this.requests.get(key);
    if (!found) {
      const gate: MergeGate = {
        state: 'open',
        sha: null,
        draft: false,
        head: `${project}-pr-${iid}`,
        mergeability: 'clean',
        blockedBy: null,
      };
      found = { gate, checks: [], refusal: null, conflict: null };
      this.requests.set(key, found);
    }
    return found;
  }

  pushRejection = unsupported;
  classifyCall = unsupported;
  pushUrl = unsupported;
  selected = unsupported as () => SelectedHost;
  secrets = unsupported as () => string[];
  openMergeRequest = unsupported;
  setDraft = unsupported;
  updateMergeRequest = unsupported;
  readMergeRequest = unsupported as (
    project: string,
    iid: number,
  ) => Promise<MergeRequestView & { httpCalls: HttpCallDraft[] }>;
  closeMergeRequest = unsupported;
  deleteBranch = unsupported;
  diagnoseMissingPipeline = unsupported;
  startPipeline = unsupported;
  listRepositories = unsupported;
  listOwners = unsupported;
  createRepository = unsupported;
  cloneUrl = unsupported;
  cloneEnv = unsupported;
  readCurrentUser = unsupported;
  cancelPipeline = unsupported;
  rerunFailedJobs = unsupported;
  readRunNotes = unsupported;
}
