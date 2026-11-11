import type { RemoteRepository, RepositoryOwner } from '../../contract/api';
import type { HttpCallDraft } from '../../core/swarmloop-error';

export interface MergeRequestQuery {
  project: string;
  source: string;
}

export interface MergeRequestDraft extends MergeRequestQuery {
  target: string;
  title: string;
  summary: string;
}

export interface MergeRequestRecord {
  project: string;
  iid: number;
  url: string;
  summary: string;
}

/** A merge request as the host reports it now. `sha` is the merge or squash commit of a merged one. */
export interface MergeRequestView {
  state: 'open' | 'merged' | 'closed';
  sha: string | null;
  conflicts: boolean;
}

export interface PipelineRef {
  project: string;
  ref: string;
  sha?: string;
}

export interface PipelineJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  allowFailure: boolean;
}

export interface CheckAnnotation {
  path: string;
  line: number;
  level: string;
  title: string;
  message: string;
}

/** One check of a commit: a workflow job, a check run of an app, or a commit status. */
export interface PipelineCheck {
  id: number;
  name: string;
  app: string;
  status: 'success' | 'failed' | 'canceled' | 'running' | 'manual' | 'skipped';
  durationMs: number;
  url: string;
  summary: string;
  annotations: CheckAnnotation[];
  /** True for a job of a workflow run or pipeline. */
  workflow: boolean;
}

/** One GitHub workflow run, or one GitLab pipeline. */
export interface PipelineRun {
  id: number;
  status: string;
  url: string;
  jobs: PipelineJob[];
}

/** Every check on the head commit. `id`, `status`, `url` and `jobs` are the aggregate of `runs` and the app `checks`. */
export interface PipelineSnapshot {
  id: number;
  status: string;
  url: string;
  jobs: PipelineJob[];
  runs: PipelineRun[];
  checks: PipelineCheck[];
  /** Checks that the host is known to start later. */
  awaiting: string[];
}

export interface PipelineDiagnosis {
  reason: string | null;
  code?: 'merge-conflict' | 'closed';
  httpCalls: HttpCallDraft[];
}

export interface CreateRepositoryDraft {
  owner: RepositoryOwner;
  name: string;
  isPublic: boolean;
}

export interface SelectedHost {
  name: 'github' | 'gitlab';
  baseUrl: string;
  token: string;
  baseKey: 'GITLAB_BASE_URL' | 'GITHUB_BASE_URL';
  tokenKey: 'GITLAB_TOKEN' | 'GITHUB_TOKEN';
}

export interface CodeHost {
  readonly name: SelectedHost['name'];
  matchesOrigin(origin: string): boolean;
  pushUrl(origin: string): string | null;
  selected(): SelectedHost;
  findMergeRequest(
    query: MergeRequestQuery,
  ): Promise<{ record: MergeRequestRecord | null; httpCalls: HttpCallDraft[] }>;
  openMergeRequest(draft: MergeRequestDraft): Promise<{ record: MergeRequestRecord; httpCalls: HttpCallDraft[] }>;
  updateMergeRequest(project: string, iid: number, summary: string): Promise<{ httpCalls: HttpCallDraft[] }>;
  readMergeRequest(project: string, iid: number): Promise<MergeRequestView & { httpCalls: HttpCallDraft[] }>;
  /** Squash-merges the request into the target branch it already has. A refusal for a conflict is a `MergeConflict`; any other refusal is a `FetchFailed` with the host's message. */
  mergeMergeRequest(project: string, iid: number): Promise<{ sha: string; httpCalls: HttpCallDraft[] }>;
  /** Closes an open request. One that is already merged or closed stays as it is. */
  closeMergeRequest(project: string, iid: number): Promise<{ httpCalls: HttpCallDraft[] }>;
  /** Deletes a branch on origin. A branch that is already gone is not an error. */
  deleteBranch(project: string, branch: string): Promise<{ httpCalls: HttpCallDraft[] }>;
  readBranchPipeline(
    ref: PipelineRef,
    jobs?: boolean,
  ): Promise<{ snapshot: PipelineSnapshot | null; httpCalls: HttpCallDraft[] }>;
  diagnoseMissingPipeline?(ref: PipelineRef): Promise<PipelineDiagnosis>;
  /** One page of the repositories the token can push to. `more` is true when a next page may exist. */
  listRepositories(
    page: number,
  ): Promise<{ repositories: RemoteRepository[]; more: boolean; httpCalls: HttpCallDraft[] }>;
  /** The accounts, organizations and groups the token may create a repository in. */
  listOwners(): Promise<{ owners: RepositoryOwner[]; httpCalls: HttpCallDraft[] }>;
  /** Creates a repository with an initial commit, so it has a default branch. A refusal is a `FetchFailed` with the host's message and the permission needed. */
  createRepository(draft: CreateRepositoryDraft): Promise<{ repository: RemoteRepository; httpCalls: HttpCallDraft[] }>;
  /** The HTTPS url to clone a project from. It holds no token. */
  cloneUrl(project: string): string;
  /** The env that lets one git command authenticate with the token, so the token stays out of argv and out of `.git/config`. */
  cloneEnv(): NodeJS.ProcessEnv;
  /** A read-only call that proves the token works. */
  readCurrentUser(): Promise<{ httpCalls: HttpCallDraft[] }>;
  readJobTrace(project: string, jobId: number): Promise<{ trace: string; httpCalls: HttpCallDraft[] }>;
  cancelPipeline(project: string, id: number): Promise<{ httpCalls: HttpCallDraft[] }>;
  /** Re-runs the failed and never-started jobs of a run on the same commit. */
  rerunFailedJobs(project: string, id: number): Promise<{ httpCalls: HttpCallDraft[] }>;
  /** The text the host gives for a run that did not run: check annotations or the pipeline's failure reason. */
  readRunNotes(project: string, id: number): Promise<{ notes: string; httpCalls: HttpCallDraft[] }>;
}
