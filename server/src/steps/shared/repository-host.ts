import { Injectable, Logger } from '@nestjs/common';
import type { RepositoryMainView } from '../../contract/repository-main';
import type { RunEntity } from '../../history/run.entity';
import { PipelinesRefused, SwarmloopError } from '../../core/swarmloop-error';
import type {
  CodeHost,
  MergeGate,
  MergeRequestRecord,
  PipelineRef,
  PipelineSnapshot,
} from '../../integrations/code-host/code-host';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
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

function hasPipeline(snapshot: PipelineSnapshot | null): snapshot is PipelineSnapshot {
  return snapshot !== null && (snapshot.runs.length > 0 || snapshot.checks.length > 0);
}

function stateOf(snapshot: PipelineSnapshot | null): RepositoryMainView['state'] {
  if (!hasPipeline(snapshot)) return 'pending';
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

  /** The pipeline of a ref, or 'refused' when the host refuses to read pipelines. */
  private async readPipeline(host: CodeHost, ref: PipelineRef): Promise<PipelineSnapshot | null | 'refused'> {
    try {
      return (await host.readBranchPipeline(ref)).snapshot;
    } catch (error) {
      if (error instanceof PipelinesRefused) return 'refused';
      throw error;
    }
  }

  /** The state of a main and, for 'none' by a refusal, its cause; the whole branch is read only when the head has no pipeline. */
  private async mainState(
    host: CodeHost,
    ref: PipelineRef,
    head: PipelineSnapshot | null | 'refused',
  ): Promise<{ state: RepositoryMainView['state']; cause: string | null }> {
    const refused = { state: 'none', cause: new PipelinesRefused().message } as const;
    if (head === 'refused') return refused;
    if (hasPipeline(head)) return { state: stateOf(head), cause: null };
    try {
      const { found } = await host.readBranchHasPipeline(ref);
      return { state: found ? 'pending' : 'none', cause: null };
    } catch (error) {
      if (error instanceof PipelinesRefused) return refused;
      throw error;
    }
  }

  private logState(repo: string, state: string, cause: string | null): void {
    if (this.logged.get(repo) === state) return;
    this.logged.set(repo, state);
    this.logger.log(cause ? `main of ${repo} reads ${state}: ${cause}` : `main of ${repo} reads ${state}`);
  }

  /** The state of a repository's default branch. */
  async main(repo: string, person: string | null): Promise<RepositoryMainView> {
    const { host, project } = await this.hostOf(repo, person);
    const { branch, sha } = await host.readDefaultHead(project);
    const ref = { project, ref: branch, sha };
    const head = await this.readPipeline(host, ref);
    const snapshot = head === 'refused' ? null : head;
    const { state, cause } = await this.mainState(host, ref, head);
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
    const read = await this.readPipeline(host, { project: request.project, ref: branch, sha: gate.head });
    const snapshot = read === 'refused' ? null : read;
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
