import { basename, join } from 'path';
import type { SwarmloopEnv } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import type { Clock } from '../core/clock';
import { runProbe } from './image-probe';
import { CheckPool, outOfMemoryError, runOnceMore } from './check-pool';
import { runShell, type ShellDeps } from './run-shell';
import { startCommandSpan } from '../core/step-event-scope';
import { SwarmloopError } from '../core/swarmloop-error';
import type { CheckCommandRepository } from '../history/check-command.repository';
import type { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime';
import type { LiveHub } from '../live/live.hub';
import { CliBundles } from '../sandbox/cli-bundle';
import type { SandboxMount } from '../core/sandbox-mount';
import type { ProjectLaunch } from '../sandbox/sandbox-launch';
import { agentImage, prepareStateDir, sandboxUserId } from '../sandbox/sandbox-launch';
import type { SandboxService } from '../sandbox/sandbox.service';
import { addCheckRows } from './check-rows';
import { checkRun, originHosts, readEnvironmentConfig } from './environment-config';
import { failuresOf, withCommand, type FailureDeps } from './check-failures';
import { checksFingerprint } from './checks-fingerprint';
import { countsFor } from '../history/gate-stamp';
import { git } from '../git/git';
import { imagePath, projectSlug, resolveProjectImage } from './project-image';
import type {
  CheckedRepo,
  CheckFailure,
  EnvironmentInput,
  EnvironmentRecord,
  FailedCommand,
  PreparedEnvironment,
} from './environment-types';

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

/** The agent's toolchain: the project image, the CLI mounted into it, and the setup that ran once for the run. */
export class ProjectEnvironments {
  private readonly bundles: CliBundles;
  private readonly probed = new Map<string, Promise<boolean>>();
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
      shell: () => this.shellDeps(),
    });
    this.bundles = new CliBundles((args, timeoutMs) => this.sandbox.run(args, timeoutMs));
  }

  /** Null when no repository of the run describes an environment: the agent then works as before. */
  async prepare(input: EnvironmentInput): Promise<PreparedEnvironment | null> {
    const { runtime } = input;
    const record = await this.record(input);
    if (!record) {
      return null;
    }
    const mount = input.mounts.find((item) => basename(item.hostPath) === record.repo) ?? input.mounts[0];
    if (!mount) {
      return null;
    }
    if (record.config.dockerfile && !record.ref) {
      throw new SwarmloopError(
        `${record.repo}: environment has no saved base revision. Rebase this run before building its project image.`,
      );
    }
    const docker = (args: string[], timeoutMs?: number) => this.sandbox.run(args, timeoutMs);
    const image = await resolveProjectImage(docker, mount.hostPath, record.repo, record.config, record.ref);
    const cliVolume = await this.cliBundle(runtime, agentImage(runtime));
    const hasCerts = await this.probe(image, cliVolume, runtime);
    const launch: ProjectLaunch = {
      image,
      cliVolume,
      path: await imagePath(docker, image),
      certFile: !hasCerts,
      caches: await this.caches(record.repo, record.config.cache),
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

  /** The CLI volume of the agent image. */
  private async cliBundle(runtime: RuntimeName, agentRef: string): Promise<string> {
    const finish = startCommandSpan({
      actor: 'server',
      repo: '',
      cwd: process.cwd(),
      executable: 'cli bundle ready',
      args: [],
    });
    try {
      const volume = await this.bundles.ensure(runtime, agentRef);
      finish({ exitCode: 0 });
      return volume;
    } catch (error) {
      finish({ exitCode: 1, output: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Server-owned completion gate. Each repository uses its own frozen commands and image. Every command runs, up to
   * CHECKS_PARALLEL at once, and a failure of one does not stop the others: the error names all of them. A command
   * with `paths` that the run's diff does not touch is skipped, unless the last return named it (`named`).
   */
  async check(input: EnvironmentInput, named: FailedCommand[] = []): Promise<{ passed: number; total: number }> {
    const attemptId = input.run.activeAttempt ?? '';
    const repos: CheckedRepo[] = [];
    let passed = 0;
    let total = 0;
    for (const mount of input.mounts) {
      const prepared = await this.prepare({ ...input, mounts: [mount] });
      const entries = prepared?.record.config.checks ?? [];
      if (!prepared || entries.length === 0) {
        continue;
      }
      const fingerprint = await this.fingerprint(input, prepared);
      const skipped = await this.skipIfPassed(input, prepared, fingerprint);
      const { rows, byPaths } = await addCheckRows(
        { documents: this.documents, commands: this.commands, live: this.live },
        { input, mount, prepared, named, skipped, offset: total },
      );
      total += entries.length;
      passed += skipped ? entries.length : byPaths;
      if (!skipped && rows.length > 0) {
        repos.push({ mount, prepared, fingerprint, rows, results: [] });
      }
    }
    await this.pool.runAll(input, attemptId, repos);
    const failures: CheckFailure[] = [];
    for (const repo of repos) {
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
   * Runs the named failed commands again, one after the other, in the environment `check` uses. A command the project
   * no longer lists is dropped. Records nothing: the full checks step stays the only gate. Returns the ones still red.
   */
  async rerun(input: EnvironmentInput, failed: FailedCommand[]): Promise<FailedCommand[]> {
    const red: FailedCommand[] = [];
    for (const mount of failed.length > 0 ? input.mounts : []) {
      const prepared = await this.prepare({ ...input, mounts: [mount] });
      if (!prepared) {
        continue;
      }
      const repo = prepared.record.repo;
      const listed = (prepared.record.config.checks ?? []).map(checkRun);
      for (const { command } of failed.filter((item) => item.repo === repo && listed.includes(item.command))) {
        const result = await runOnceMore(this.shellDeps(), input, prepared.launch, command, mount);
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

  /** Once per image and CLI: does the CLI start there, and does the image bring its own CA bundle. */
  private probe(image: string, cliVolume: string, runtime: RuntimeName): Promise<boolean> {
    const key = `${image}\0${cliVolume}`;
    let found = this.probed.get(key);
    if (!found) {
      found = runProbe(this.sandbox, image, cliVolume, runtime).catch((error: unknown) => {
        this.probed.delete(key);
        throw error;
      });
      this.probed.set(key, found);
    }
    return found;
  }

  private async caches(repo: string, paths: string[]): Promise<ProjectLaunch['caches']> {
    const root = resolveRepoRoot(this.deps.env().SWARMLOOP_ROOT, __dirname);
    const userId = sandboxUserId();
    const caches: ProjectLaunch['caches'] = [];
    for (const containerPath of paths) {
      const dir = join(root, 'data', 'env-cache', projectSlug(repo), containerPath.slice(1).replace(/\//g, '-'));
      prepareStateDir(dir, userId);
      caches.push({ containerPath, daemonPath: (await this.sandbox.stateDaemonPath(dir)) ?? dir });
    }
    return caches;
  }
}
