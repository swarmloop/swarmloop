import { HttpCallDraft } from '../../swarmloop-error';

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

export interface PipelineSnapshot {
  id: number;
  status: string;
  url: string;
  jobs: PipelineJob[];
}

export interface CodeHost {
  findMergeRequest(query: MergeRequestQuery): Promise<{ record: MergeRequestRecord | null; httpCalls: HttpCallDraft[] }>;
  openMergeRequest(draft: MergeRequestDraft): Promise<{ record: MergeRequestRecord; httpCalls: HttpCallDraft[] }>;
  updateMergeRequest(project: string, iid: number, summary: string): Promise<{ httpCalls: HttpCallDraft[] }>;
  readBranchPipeline(ref: PipelineRef): Promise<{ snapshot: PipelineSnapshot | null; httpCalls: HttpCallDraft[] }>;
  readJobTrace(project: string, jobId: number): Promise<{ trace: string; httpCalls: HttpCallDraft[] }>;
  cancelPipeline(project: string, id: number): Promise<{ httpCalls: HttpCallDraft[] }>;
}
