import { Injectable } from '@nestjs/common';
import type { RepositoryMainView } from '../../contract/repository-main';
import { SwarmloopError } from '../../core/swarmloop-error';
import type { MergeGate, MergeRequestRecord, PipelineSnapshot } from '../../integrations/code-host/code-host';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { RepositoryOrigins } from './repository-origins';

type MergeRequestRef = Pick<MergeRequestRecord, 'project' | 'iid'>;
type HostRun = { codeHost: string; startedBy: string | null };

/** A failed job of a main: its name, its log and where the whole run is on the host. */
interface FailedJob {
  name: string;
  trace: string;
  url: string;
}

type GateReading = MergeGate & { failing: string[]; pending: string[] };

function stateOf(snapshot: PipelineSnapshot | null): RepositoryMainView['state'] {
  if (!snapshot || (snapshot.runs.length === 0 && snapshot.checks.length === 0)) return 'pending';
  if (snapshot.status === 'success') return 'green';
  return snapshot.status === 'failed' || snapshot.status === 'canceled' ? 'red' : 'pending';
}

function namesOf(snapshot: PipelineSnapshot | null, statuses: string[]): string[] {
  return (snapshot?.checks ?? []).filter((check) => statuses.includes(check.status)).map((check) => check.name);
}

/** What the backlog layer reads from and does on a code host, by repository name or by merge request. */
@Injectable()
export class RepositoryHost {
  constructor(
    private readonly origins: RepositoryOrigins,
    private readonly hosts: CodeHostRegistry,
  ) {}

  private async hostOf(repo: string, person: string | null) {
    const { origin, project } = await this.origins.of(repo);
    const scoped = await this.hosts.forRun(person);
    const name = scoped.forOrigin(origin);
    if (name === null) throw new SwarmloopError(`${repo} is not on a known code host`);
    return { host: scoped.byName(name), project };
  }

  /** The state of a repository's default branch. */
  async main(repo: string, person: string | null): Promise<RepositoryMainView> {
    const { host, project } = await this.hostOf(repo, person);
    const { branch, sha } = await host.readDefaultHead(project);
    const { snapshot } = await host.readBranchPipeline({ project, ref: branch, sha });
    const durations = (snapshot?.checks ?? []).map((check) => check.durationMs);
    return {
      repository: repo,
      branch,
      state: stateOf(snapshot),
      head: sha,
      failingJobs: namesOf(snapshot, ['failed', 'canceled']),
      durationMs: durations.length > 0 ? Math.max(...durations) : null,
      url: snapshot?.url ?? null,
    };
  }

  /** The first failed job of a repository's default branch with its whole log, or null when no job of a workflow failed. */
  async failedMainJob(repo: string, person: string | null): Promise<FailedJob | null> {
    const { host, project } = await this.hostOf(repo, person);
    const { branch, sha } = await host.readDefaultHead(project);
    const { snapshot } = await host.readBranchPipeline({ project, ref: branch, sha });
    const failed = (snapshot?.checks ?? []).find(
      (check) => check.workflow && (check.status === 'failed' || check.status === 'canceled'),
    );
    if (!failed) return null;
    const { trace } = await host.readJobTrace(project, failed.id);
    return { name: failed.name, trace, url: failed.url || snapshot?.url || '' };
  }

  /** A merge request's gate, with the names of its failing and pending checks on the head. */
  async gate(run: HostRun, request: MergeRequestRef, branch: string): Promise<GateReading> {
    const host = await this.hosts.hostFor(run);
    const { httpCalls: _calls, ...gate } = await host.readMergeGate(request.project, request.iid);
    const { snapshot } = await host.readBranchPipeline({ project: request.project, ref: branch, sha: gate.head });
    return {
      ...gate,
      failing: namesOf(snapshot, ['failed', 'canceled']),
      pending: namesOf(snapshot, ['running', 'manual']),
    };
  }

  /** Merges a request, guarded by its head commit; the commit it made. */
  async merge(run: HostRun, request: MergeRequestRef, head: string): Promise<string> {
    const host = await this.hosts.hostFor(run);
    return (await host.mergeMergeRequest(request.project, request.iid, head)).sha;
  }
}
