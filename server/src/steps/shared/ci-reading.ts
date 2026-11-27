import type { RepositoryMainView } from '../../contract/repository-main';
import { PipelinesRefused, type HttpCallDraft } from '../../core/swarmloop-error';
import type { CodeHost, PipelineRef, PipelineSnapshot } from '../../integrations/code-host/code-host';

/** What one read of a ref's pipeline came to: its snapshot, or that the host refuses to read pipelines. */
interface CiReading {
  snapshot: PipelineSnapshot | null;
  refused: boolean;
  httpCalls: HttpCallDraft[];
}

interface CiStateReading {
  state: RepositoryMainView['state'];
  /** Why the state is 'none' when the host refused; null otherwise. */
  cause: string | null;
  httpCalls: HttpCallDraft[];
}

const NEVER_HAD_CI = 'no pipeline was ever run on its main or on the branch of the run';

/** A refusal of the host is a reading of a ref, never a failure: the ref has no CI the step can see. */
export async function readCi(host: CodeHost, ref: PipelineRef, jobs?: boolean): Promise<CiReading> {
  try {
    const { snapshot, httpCalls } = await host.readBranchPipeline(ref, jobs);
    return { snapshot, refused: false, httpCalls };
  } catch (error) {
    if (error instanceof PipelinesRefused) {
      return { snapshot: null, refused: true, httpCalls: error.httpCalls };
    }
    throw error;
  }
}

function hasPipeline(snapshot: PipelineSnapshot | null): snapshot is PipelineSnapshot {
  return snapshot !== null && (snapshot.runs.length > 0 || snapshot.checks.length > 0);
}

function stateOf(snapshot: PipelineSnapshot): RepositoryMainView['state'] {
  if (snapshot.status === 'success') return 'green';
  return snapshot.status === 'failed' || snapshot.status === 'canceled' ? 'red' : 'pending';
}

/**
 * The one rule of whether a ref has CI. 'none' is a host that refuses to read pipelines, or a branch that never had a
 * pipeline, check or status; the whole branch is read only when the commit itself shows none.
 */
export async function ciState(host: CodeHost, ref: PipelineRef, read: CiReading): Promise<CiStateReading> {
  const refused = { state: 'none', cause: new PipelinesRefused().message } as const;
  if (read.refused) return { ...refused, httpCalls: read.httpCalls };
  if (hasPipeline(read.snapshot)) {
    return { state: stateOf(read.snapshot), cause: null, httpCalls: read.httpCalls };
  }
  try {
    const { found, httpCalls } = await host.readBranchHasPipeline(ref);
    return { state: found ? 'pending' : 'none', cause: null, httpCalls: [...read.httpCalls, ...httpCalls] };
  } catch (error) {
    if (error instanceof PipelinesRefused) return { ...refused, httpCalls: [...read.httpCalls, ...error.httpCalls] };
    throw error;
  }
}

/**
 * Whether a project of a run has no CI at all: the run's own ref and the project's main both read 'none'. A pipeline,
 * check or status on the run's ref means CI runs for it, even one that runs only for merge requests. `cause` is null
 * when the project has CI; `refused` says the host refuses to read its pipelines, so no run can ever be seen.
 */
export async function noCi(
  host: CodeHost,
  own: PipelineRef,
): Promise<{ cause: string | null; refused: boolean; httpCalls: HttpCallDraft[] }> {
  const onOwn = await ciState(host, own, await readCi(host, own));
  if (onOwn.state !== 'none') {
    return { cause: null, refused: false, httpCalls: onOwn.httpCalls };
  }
  const { branch, sha, httpCalls } = await host.readDefaultHead(own.project);
  const main = { project: own.project, ref: branch, sha };
  const onMain = await ciState(host, main, await readCi(host, main));
  const calls = [...onOwn.httpCalls, ...httpCalls, ...onMain.httpCalls];
  if (onMain.state !== 'none') {
    return { cause: null, refused: false, httpCalls: calls };
  }
  const refusal = onOwn.cause ?? onMain.cause;
  return { cause: refusal ?? NEVER_HAD_CI, refused: refusal !== null, httpCalls: calls };
}
