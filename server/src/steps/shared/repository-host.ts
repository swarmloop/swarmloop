import { Injectable } from '@nestjs/common';
import type { RepositoryMainView } from '../../contract/repository-main';
import type { RunEntity } from '../../history/run.entity';
import { SwarmloopError } from '../../core/swarmloop-error';
import type { MergeGate, MergeRequestRecord, PipelineSnapshot } from '../../integrations/code-host/code-host';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { mergeHow } from './merge-method';
import { RepositoryOrigins } from './repository-origins';
import { RunNames } from './run-names';

type MergeRequestRef = Pick<MergeRequestRecord, 'project' | 'iid'>;
type HostRun = { codeHost: string; startedBy: string | null };
type MergeRun = HostRun & Pick<RunEntity, 'key' | 'parentRunId' | 'taskId'>;

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
    private readonly names: RunNames,
  ) {}

  /** The state of a repository's default branch. */
  async main(repo: string, person: string | null): Promise<RepositoryMainView> {
    const { origin, project } = await this.origins.of(repo);
    const scoped = await this.hosts.forRun(person);
    const name = scoped.forOrigin(origin);
    if (name === null) throw new SwarmloopError(`${repo} is not on a known code host`);
    const host = scoped.byName(name);
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

  /** Merges a request of a task, guarded by its head commit, with the method the repository allows; the commit it made. */
  async merge(run: MergeRun, repo: string, taskTitle: string, request: MergeRequestRef, head: string): Promise<string> {
    const host = await this.hosts.hostFor(run);
    const how = await mergeHow(host, request.project, await this.names.taskTitle(run, repo, taskTitle));
    return (await host.mergeMergeRequest(request.project, request.iid, head, how)).sha;
  }
}
