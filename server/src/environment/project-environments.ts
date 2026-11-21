import { basename } from 'path';
import type { SwarmloopEnv } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import type { Clock } from '../core/clock';
import { CheckPool, ChecksStopped, outOfMemoryError, runOnceMore, waitingText } from './check-pool';
import { runShell, type ShellDeps } from './run-shell';
import { SwarmloopError } from '../core/swarmloop-error';
import type { CheckCommandRepository } from '../history/check-command.repository';
import type { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import type { LiveHub } from '../live/live.hub';
import type { SandboxMount } from '../core/sandbox-mount';
import type { ProjectLaunch } from '../sandbox/sandbox-launch';
import { agentImage } from '../sandbox/sandbox-launch';
import type { SandboxService } from '../sandbox/sandbox.service';
import { addCheckRows } from './check-rows';
import { recordPasses, visitStart, type VisitStart } from './check-passes';
import { checkRun, originHosts, readEnvironmentConfig } from './environment-config';
import { failuresOf, withCommand, type FailureDeps } from './check-failures';
import { checksFingerprint } from './checks-fingerprint';
import { countsFor } from '../history/gate-stamp';
import { git } from '../git/git';
import { ImageBuildFailed, imagePath, resolveProjectImage } from './project-image';
import { ProjectLaunches } from './project-launches';
import { checksDefinition, HeadEnvironmentUnreadable, type ImageSource } from './checks-definition';
import type {
  CheckedRepo,
  CheckFailure,
  EnvironmentInput,
  EnvironmentRecord,
  FailedCommand,
  PreparedEnvironment,
} from './environment-types';

/** The reason a changed definition cannot be checked on, or null for any other error. */
function headFailure(error: unknown): string | null {
  return error instanceof HeadEnvironmentUnreadable || error instanceof ImageBuildFailed ? error.message : null;
}

export const ENVIRONMENT = 'environment';
const CHECKS_PASS = 'checks_pass';
/** A completed check rejected the code; implementation can repair it using the saved feedback. */
export class RequiredCheckFailed extends SwarmloopError {
  constructor(
    message: string,
    /** The failed commands as data. Empty when only the project files changed. */
    readonly failed: FailedCommand[] = [],
  ) {
    super(message);
  }
}
/** The same check failed again on files no pass has changed: another launch would repeat it. */
export class RequiredCheckRepeated extends RequiredCheckFailed {}

interface EnvironmentDeps {
  env: () => Pick<SwarmloopEnv, 'SWARMLOOP_ROOT' | 'CHECKS_PARALLEL'>;
  clock: Clock;
  sandbox: Pick<SandboxService, 'run' | 'spawn' | 'kill' | 'stateDaemonPath' | 'stats'>;
  documents: Pick<DocumentRepository, 'latestBody' | 'putDocument'>;
  commands: Pick<CheckCommandRepository, 'add' | 'save'>;
  live?: Pick<LiveHub, 'log' | 'changed'>;
  halted?: (key: string) => boolean;
}

/**
 * The agent's toolchain: the project image of the run's base revision, the CLI mounted into it, and the setup that ran
 * once for the run. The checks use the run's own commands in the image the changed files define; the agent never does.
 */
export class ProjectEnvironments {
  private readonly launches: ProjectLaunches;
  private readonly clock: Clock;
  private readonly sandbox: EnvironmentDeps['sandbox'];
  private readonly documents: EnvironmentDeps['documents'];
  private readonly commands: EnvironmentDeps['commands'];
  private readonly live?: EnvironmentDeps['live'];
  private readonly pool: CheckPool;

  constructor(private readonly deps: EnvironmentDeps) {
    this.clock = deps.clock;
    this.sandbox = deps.sandbox;
    this.documents = deps.documents;
    this.commands = deps.commands;
    this.live = deps.live;
    this.pool = new CheckPool({
      checksParallel: () => deps.env().CHECKS_PARALLEL,
      clock: deps.clock,
      documents: deps.documents,
      commands: deps.commands,
      live: deps.live,
      halted: deps.halted,
      shell: () => this.shellDeps(),
    });
    this.launches = new ProjectLaunches(deps);
  }

  /** Takes the waiting check commands of a run out of the line. */
  protected stopWaiting(key: string): void {
    this.pool.stopWaiting(key);
  }

  /** Null when no repository of the run describes an environment: the agent then works as before. */
  async prepare(input: EnvironmentInput): Promise<PreparedEnvironment | null> {
    const found = await this.locate(input);
    if (!found) {
      return null;
    }
    const { record, mount } = found;
    return this.prepareIn(input, record, mount, { config: record.config, ref: record.ref });
  }

  /** The environment the checks run in: the run's own commands and setup, in the image the changed files define. */
  private async prepareForChecks(input: EnvironmentInput): Promise<PreparedEnvironment | null> {
    const found = await this.locate(input);
    if (!found) {
      return null;
    }
    const { record, mount } = found;
    return this.prepareIn(input, record, mount, await checksDefinition(mount, record));
  }

  private async locate(input: EnvironmentInput): Promise<{ record: EnvironmentRecord; mount: SandboxMount } | null> {
    const record = await this.record(input);
    if (!record) {
      return null;
    }
    const mount = input.mounts.find((item) => basename(item.hostPath) === record.repo) ?? input.mounts[0];
    return mount ? { record, mount } : null;
  }

  /** The image comes from `source`, everything else (setup, hosts, caches) from the record. */
  private async prepareIn(
    input: EnvironmentInput,
    record: EnvironmentRecord,
    mount: SandboxMount,
    source: ImageSource,
  ): Promise<PreparedEnvironment> {
    const { runtime } = input;
    if (source.config.dockerfile && !source.ref) {
      throw new SwarmloopError(
        `${record.repo}: environment has no saved base revision. Rebase this run before building its project image.`,
      );
    }
    const docker = (args: string[], timeoutMs?: number) => this.sandbox.run(args, timeoutMs);
    const image = await resolveProjectImage(docker, mount.hostPath, record.repo, source.config, source.ref);
    const cliVolume = await this.launches.cliBundle(runtime, agentImage(runtime));
    const hasCerts = await this.launches.probe(image, cliVolume, runtime);
    const launch: ProjectLaunch = {
      image,
      cliVolume,
      path: await imagePath(docker, image),
      certFile: !hasCerts,
      caches: await this.launches.caches(record.repo, record.config.cache),
    };
    const origins = record.config.hosts ? await originHosts(mount.hostPath) : [];
    const command = record.config.setup;
    const done = record.setup?.exitCode === 0 && record.setup.command === command && record.setup.image === image;
    if (command && !done) {
      const manifest = { hosts: record.config.hosts?.setup ?? [], origins };
      const result = await runShell(this.shellDeps(), input, launch, command, mount, 'setup', undefined, manifest);
      record.setup = { command, image, exitCode: result.exitCode, tail: result.tail };
      await this.documents.putDocument(input.run, ENVIRONMENT, JSON.stringify(record));
      await this.documents.putDocument(input.run, `${ENVIRONMENT}:${record.repo}`, JSON.stringify(record));
    }
    if (record.setup && record.setup.exitCode !== 0) {
      throw new SwarmloopError(
        `${record.repo} environment setup failed (exit ${record.setup.exitCode}):\n${record.setup.tail}`,
      );
    }
    return { launch, record: { ...record, image }, origins };
  }

  /**
   * Server-owned completion gate. Each repository uses its own frozen commands, in the image its changed files define. Every command runs, up to
   * CHECKS_PARALLEL at once, and a failure of one does not stop the others: the error names all of them. A command
   * with `paths` is skipped, unless the last return named it (`named`), when the run's diff does not touch them or when
   * it passed earlier in this run on the same files under them; a change outside every `paths` list runs all.
   */
  async check(input: EnvironmentInput, named: FailedCommand[] = []): Promise<{ passed: number; total: number }> {
    const attemptId = input.run.activeAttempt ?? '';
    const repos: CheckedRepo[] = [];
    const starts = new Map<CheckedRepo, VisitStart>();
    const failures: CheckFailure[] = [];
    let passed = 0;
    let total = 0;
    for (const mount of input.mounts) {
      let prepared: PreparedEnvironment | null;
      try {
        prepared = await this.prepareForChecks({ ...input, mounts: [mount] });
      } catch (error) {
        const reason = headFailure(error);
        if (reason === null) throw error;
        failures.push({ repo: basename(mount.hostPath), body: `${basename(mount.hostPath)}: ${reason}`, repeated: '' });
        continue;
      }
      const entries = prepared?.record.config.checks ?? [];
      if (!prepared || entries.length === 0) {
        continue;
      }
      const fingerprint = await this.fingerprint(input, prepared);
      const skipped = await this.skipIfPassed(input, prepared, fingerprint);
      const start = skipped ? null : await visitStart(mount, prepared, (args, ms) => this.sandbox.run(args, ms));
      const { rows, byPaths } = await addCheckRows(
        { documents: this.documents, commands: this.commands, live: this.live },
        { input, mount, prepared, named, skipped, offset: total, start },
      );
      total += entries.length;
      passed += skipped ? entries.length : byPaths;
      if (!skipped && rows.length > 0) {
        const repo: CheckedRepo = { mount, prepared, fingerprint, rows, results: [] };
        repos.push(repo);
        if (start) {
          starts.set(repo, start);
        }
      }
    }
    await this.pool.runAll(input, attemptId, repos);
    for (const repo of repos) {
      await recordPasses({ clock: this.clock, documents: this.documents }, input, repo, starts.get(repo) ?? null);
      const own = await failuresOf(this.failureDeps(), input, repo);
      failures.push(...own);
      if (own.length === 0) {
        passed += repo.rows.length;
        await this.documents.putDocument(
          input.run,
          `${CHECKS_PASS}:${repo.prepared.record.repo}`,
          JSON.stringify({
            generation: input.run.generation,
            fingerprint: repo.fingerprint,
            step: input.step,
            at: this.clock.iso(),
          }),
        );
      }
    }
    if (failures.length > 0) {
      const body = failures.map((failure) => failure.body).join('\n\n');
      await this.documents.putDocument(input.run, 'return', `## checks\n${body}\n`);
      const repeated = failures.find((failure) => failure.repeated);
      const failed = failures.flatMap((failure) => (failure.failed ? [failure.failed] : []));
      throw repeated ? new RequiredCheckRepeated(repeated.repeated) : new RequiredCheckFailed(body, failed);
    }
    return { passed, total };
  }

  /**
   * Runs the named failed commands again, one after the other, in the image `check` uses: the one the changed files define. A command the project
   * no longer lists is dropped. Records nothing: the full checks step stays the only gate. Returns the ones still red.
   */
  async rerun(input: EnvironmentInput, failed: FailedCommand[]): Promise<FailedCommand[]> {
    const red: FailedCommand[] = [];
    for (const mount of failed.length > 0 ? input.mounts : []) {
      let prepared: PreparedEnvironment | null;
      try {
        prepared = await this.prepareForChecks({ ...input, mounts: [mount] });
      } catch (error) {
        const reason = headFailure(error);
        if (reason === null) throw error;
        const repo = basename(mount.hostPath);
        red.push(
          ...failed.filter((item) => item.repo === repo).map(({ command }) => ({ repo, command, tail: reason })),
        );
        continue;
      }
      if (!prepared) {
        continue;
      }
      const repo = prepared.record.repo;
      const listed = (prepared.record.config.checks ?? []).map(checkRun);
      for (const { command } of failed.filter((item) => item.repo === repo && listed.includes(item.command))) {
        const result = await this.pool.withPlace(
          input,
          (ahead) => this.live?.log({ key: input.key, step: input.step, body: `${waitingText(ahead)}\n` }),
          (place) => runOnceMore(this.shellDeps(), input, prepared.launch, command, mount, undefined, place),
        );
        if (!result) {
          throw new ChecksStopped();
        }
        if (result.outOfMemoryBytes !== undefined) {
          throw outOfMemoryError(repo, command, result.outOfMemoryBytes);
        }
        if (result.exitCode !== 0) {
          red.push({ repo, command, tail: withCommand(command, result.tail) });
        }
      }
    }
    return red;
  }

  private shellDeps(): ShellDeps {
    return {
      root: resolveRepoRoot(this.deps.env().SWARMLOOP_ROOT, __dirname),
      clock: this.clock,
      sandbox: this.sandbox,
      live: this.live,
      halted: this.deps.halted,
    };
  }

  private failureDeps(): FailureDeps {
    return {
      clock: this.clock,
      documents: this.documents,
      fingerprint: (input, prepared) => this.fingerprint(input, prepared),
    };
  }

  private fingerprint(input: EnvironmentInput, prepared: PreparedEnvironment): Promise<string> {
    return checksFingerprint(input, prepared, (args, timeoutMs) => this.sandbox.run(args, timeoutMs));
  }

  /** True when these checks already passed on the same files: it records the skip and runs nothing. */
  private async skipIfPassed(
    input: EnvironmentInput,
    prepared: PreparedEnvironment,
    fingerprint: string,
  ): Promise<boolean> {
    const repo = prepared.record.repo;
    const stored = await this.documents.latestBody(input.key, `${CHECKS_PASS}:${repo}`);
    const pass = stored ? (JSON.parse(stored) as { generation?: number; fingerprint: string; step: string }) : null;
    if (!pass || !countsFor(input.run, pass, fingerprint)) {
      return false;
    }
    const tail = `skipped: these checks passed on the same files in ${pass.step}`;
    await this.documents.putDocument(
      input.run,
      'checks',
      JSON.stringify({ repo, skipped: true, sameAs: pass.step, exitCode: 0, tail }),
    );
    this.live?.log({ key: input.key, step: input.step, body: `${tail}\n` });
    return true;
  }

  /** The config is read once per run and kept, so a change the agent commits does not move the run to another image. */
  protected async record(input: {
    run: RunEntity;
    key: string;
    mounts: SandboxMount[];
  }): Promise<EnvironmentRecord | null> {
    const legacy = await this.documents.latestBody(input.key, ENVIRONMENT);
    for (const mount of input.mounts) {
      const repo = basename(mount.hostPath);
      const scoped = await this.documents.latestBody(input.key, `${ENVIRONMENT}:${repo}`);
      if (scoped === 'null') continue;
      const record = JSON.parse(scoped ?? legacy ?? 'null') as EnvironmentRecord | null;
      if (record?.repo === repo) {
        if (!scoped) await this.documents.putDocument(input.run, `${ENVIRONMENT}:${repo}`, JSON.stringify(record));
        return record;
      }
      const ref = await git(['-C', mount.hostPath, 'rev-parse', '--verify', 'HEAD^{commit}']);
      const config = await readEnvironmentConfig(mount.hostPath, ref);
      if (config) {
        const record: EnvironmentRecord = { repo: basename(mount.hostPath), ref, config };
        await this.documents.putDocument(input.run, ENVIRONMENT, JSON.stringify(record));
        await this.documents.putDocument(input.run, `${ENVIRONMENT}:${record.repo}`, JSON.stringify(record));
        return record;
      }
      await this.documents.putDocument(input.run, `${ENVIRONMENT}:${repo}`, 'null');
    }
    return null;
  }
}
