import { Injectable, Logger } from '@nestjs/common';
import type { RepositoryMainView } from '../../contract/repository-main';
import type { RunEntity } from '../../history/run.entity';
import { SwarmloopError } from '../../core/swarmloop-error';
import type { MergeGate, MergeRequestRecord, PipelineSnapshot } from '../../integrations/code-host/code-host';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { ciState, readCi } from './ci-reading';
import { mergeHow } from './merge-method';
import { RepositoryOrigins } from './repository-origins';
import { RunNames } from './run-names';

type MergeRequestRef = Pick<MergeRequestRecord, 'project' | 'iid'>;
type HostRun = { codeHost: string; startedBy: string | null };
type MergeRun = HostRun & Pick<RunEntity, 'key' | 'parentRunId' | 'taskId'>;

/** A failed job of a main: its name, its log and where the whole run is on the host. */
interface FailedJob {
  name: string;
  trace: string;
  url: string;
}

type GateReading = MergeGate & { failing: string[]; pending: string[] };

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

  private readonly logger = new Logger(RepositoryHost.name);
  /** The state of each repository's main as last logged. */
  private readonly logged = new Map<string, string>();

  private async hostOf(repo: string, person: string | null) {
    const { origin, project } = await this.origins.of(repo);
    const scoped = await this.hosts.forRun(person);
    const name = scoped.forOrigin(origin);
    if (name === null) throw new SwarmloopError(`${repo} is not on a known code host`);
    return { host: scoped.byName(name), project };
  }

  private logState(repo: string, state: string, cause: string | null): void {
    if (this.logged.get(repo) === state) return;
    this.logged.set(repo, state);
    this.logger.log(cause ? `main of ${repo} reads ${state}: ${cause}` : `main of ${repo} reads ${state}`);
  }

  /** The name of a repository's default branch. */
  async defaultBranch(repo: string, person: string | null): Promise<string> {
    const { host, project } = await this.hostOf(repo, person);
    return (await host.readDefaultHead(project)).branch;
  }

  /** The state of a repository's default branch. */
  async main(repo: string, person: string | null): Promise<RepositoryMainView> {
    const { host, project } = await this.hostOf(repo, person);
    const { branch, sha } = await host.readDefaultHead(project);
    const ref = { project, ref: branch, sha };
    const reading = await readCi(host, ref);
    const { snapshot } = reading;
    const { state, cause } = await ciState(host, ref, reading);
    this.logState(repo, state, cause);
    const durations = (snapshot?.checks ?? []).map((check) => check.durationMs);
    return {
      repository: repo,
      branch,
      state,
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
    const { snapshot } = await readCi(host, { project: request.project, ref: branch, sha: gate.head });
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

  /** Deletes a branch of a project on the host a run talks to. */
  async deleteBranch(run: HostRun, project: string, branch: string): Promise<void> {
    await (await this.hosts.hostFor(run)).deleteBranch(project, branch);
  }
}
