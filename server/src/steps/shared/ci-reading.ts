import type { RepositoryMainView } from '../../contract/repository-main';
import type { HttpCallDraft } from '../../core/swarmloop-error';
import type { CodeHost, PipelineRef, PipelineSnapshot } from '../../integrations/code-host/code-host';

/** What one read of a ref's pipeline came to. */
interface CiReading {
  snapshot: PipelineSnapshot | null;
  httpCalls: HttpCallDraft[];
}

interface CiStateReading extends CiReading {
  state: RepositoryMainView['state'];
}

/**
 * The one rule of whether a project has CI: its code host's own answer. A host that cannot answer rejects with its
 * outage wait, and that rejection is passed on, never read as no CI.
 */
export function projectHasCi(host: CodeHost, project: string): Promise<boolean> {
  return host.ciEnabled(project);
}

/** The pipeline of a ref, with its checks and statuses. */
export async function readCi(host: CodeHost, ref: PipelineRef, jobs?: boolean): Promise<CiReading> {
  const { snapshot, httpCalls } = await host.readBranchPipeline(ref, jobs);
  return { snapshot, httpCalls };
}

function hasPipeline(snapshot: PipelineSnapshot | null): snapshot is PipelineSnapshot {
  return snapshot !== null && (snapshot.runs.length > 0 || snapshot.checks.length > 0);
}

function stateOf(snapshot: PipelineSnapshot): RepositoryMainView['state'] {
  if (snapshot.status === 'success') return 'green';
  return snapshot.status === 'failed' || snapshot.status === 'canceled' ? 'red' : 'pending';
}

/**
 * The state of a ref's CI. 'none' is a project whose host reports no CI, or a ref with no pipeline, check or status
 * on any commit of its branch (CI that runs only for merge requests). A project with CI whose ref shows none on its
 * commit is 'pending' when its branch had one before: the CI has not started yet.
 */
export async function ciState(host: CodeHost, ref: PipelineRef): Promise<CiStateReading> {
  if (!(await projectHasCi(host, ref.project))) {
    return { state: 'none', snapshot: null, httpCalls: [] };
  }
  const read = await readCi(host, ref);
  if (hasPipeline(read.snapshot)) {
    return { ...read, state: stateOf(read.snapshot) };
  }
  const { found, httpCalls } = await host.readBranchHasPipeline(ref);
  return { snapshot: read.snapshot, state: found ? 'pending' : 'none', httpCalls: [...read.httpCalls, ...httpCalls] };
}
