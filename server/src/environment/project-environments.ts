import { mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import type { SwarmloopEnv } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import type { Clock } from '../core/clock';
import { SwarmloopError } from '../core/swarmloop-error';
import type { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import type { LiveHub } from '../live/live.hub';
import { CLI_BIN, CliBundles } from '../sandbox/cli-bundle';
import type { ProjectLaunch, SandboxMount } from '../sandbox/sandbox-launch';
import { agentStateDir, imageName, prepareStateDir, sandboxUserId, setupHosts } from '../sandbox/sandbox-launch';
import type { SandboxService } from '../sandbox/sandbox.service';
import { type EnvironmentConfig, readEnvironmentConfig } from './environment-config';
import { imagePath, projectSlug, resolveProjectImage } from './project-image';

export const ENVIRONMENT = 'environment';
const SETUP_TIMEOUT_MS = 30 * 60_000;
const TAIL_LINES = 80;
const TAIL_CHARS = 6000;

/** What a run keeps about its environment: the config it started with and how the setup went. */
export interface EnvironmentRecord {
  repo: string;
  config: EnvironmentConfig;
  image?: string;
  setup?: { command: string; image: string; exitCode: number; tail: string };
}

export interface PreparedEnvironment {
  launch: ProjectLaunch;
  record: EnvironmentRecord;
}

export interface EnvironmentDeps {
  env: () => Pick<SwarmloopEnv, 'RUNTIME' | 'SWARMLOOP_ROOT'>;
  clock: Clock;
  sandbox: Pick<SandboxService, 'run' | 'spawn' | 'kill' | 'stateDaemonPath'>;
  documents: Pick<DocumentRepository, 'latestBody' | 'putDocument'>;
  live?: Pick<LiveHub, 'log'>;
}

/** The agent's toolchain: the project image, the CLI mounted into it, and the setup that ran once for the run. */
export class ProjectEnvironments {
  private readonly bundles: CliBundles;
  private readonly probed = new Map<string, Promise<boolean>>();
  private readonly clock: Clock;
  private readonly sandbox: EnvironmentDeps['sandbox'];
  private readonly documents: EnvironmentDeps['documents'];
  private readonly live?: EnvironmentDeps['live'];

  constructor(private readonly deps: EnvironmentDeps) {
    this.clock = deps.clock;
    this.sandbox = deps.sandbox;
    this.documents = deps.documents;
    this.live = deps.live;
    this.bundles = new CliBundles((args, timeoutMs) => this.sandbox.run(args, timeoutMs));
  }

  /** Null when no repository of the run describes an environment: the agent then works as before. */
  async prepare(input: {
    run: RunEntity;
    key: string;
    step: string;
    mounts: SandboxMount[];
  }): Promise<PreparedEnvironment | null> {
    const runtime = this.deps.env().RUNTIME;
    const record = await this.record(input);
    if (!record) {
      return null;
    }
    const mount = input.mounts.find((item) => basename(item.hostPath) === record.repo) ?? input.mounts[0];
    if (!mount) {
      return null;
    }
    const docker = (args: string[], timeoutMs?: number) => this.sandbox.run(args, timeoutMs);
    const image = await resolveProjectImage(docker, mount.hostPath, record.repo, record.config);
    const cliVolume = await this.bundles.ensure(runtime, imageName(runtime));
    const hasCerts = await this.probe(image, cliVolume, runtime);
    const launch: ProjectLaunch = {
      image,
      cliVolume,
      path: await imagePath(docker, image),
      certFile: !hasCerts,
      caches: await this.caches(record.repo, record.config.cache),
    };
    const command = record.config.setup;
    const done = record.setup && record.setup.command === command && record.setup.image === image;
    if (command && !done) {
      const result = await this.setup(input, launch, command, mount);
      record.setup = { command, image, ...result };
      await this.documents.putDocument(input.run, ENVIRONMENT, JSON.stringify(record));
    }
    return { launch, record: { ...record, image } };
  }

  /** The config is read once per run and kept, so a change the agent commits does not move the run to another image. */
  private async record(input: {
    run: RunEntity;
    key: string;
    mounts: SandboxMount[];
  }): Promise<EnvironmentRecord | null> {
    const stored = await this.documents.latestBody(input.key, ENVIRONMENT);
    if (stored) {
      return JSON.parse(stored) as EnvironmentRecord;
    }
    for (const mount of input.mounts) {
      const config = await readEnvironmentConfig(mount.hostPath);
      if (config) {
        const record: EnvironmentRecord = { repo: basename(mount.hostPath), config };
        await this.documents.putDocument(input.run, ENVIRONMENT, JSON.stringify(record));
        return record;
      }
    }
    return null;
  }

  /** Once per image and CLI: does the CLI start there, and does the image bring its own CA bundle. */
  private probe(image: string, cliVolume: string, runtime: RuntimeName): Promise<boolean> {
    const key = `${image}\0${cliVolume}`;
    let found = this.probed.get(key);
    if (!found) {
      found = this.runProbe(image, cliVolume, runtime).catch((error: unknown) => {
        this.probed.delete(key);
        throw error;
      });
      this.probed.set(key, found);
    }
    return found;
  }

  private async runProbe(image: string, cliVolume: string, runtime: RuntimeName): Promise<boolean> {
    const userId = sandboxUserId();
    const cli = `${CLI_BIN}/${runtimeFor(runtime).command}`;
    const script = `if [ -f /etc/ssl/certs/ca-certificates.crt ]; then echo certs=yes; else echo certs=no; fi; ${cli} --version`;
    let out: string;
    try {
      out = await this.sandbox.run(
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--user',
          `${userId}:${userId}`,
          '--read-only',
          '--tmpfs',
          '/tmp:rw,exec,nosuid,nodev,size=64m,mode=1777',
          '--tmpfs',
          `/home/sandbox:rw,nosuid,nodev,size=64m,uid=${userId},gid=${userId},mode=700`,
          '--env',
          'HOME=/home/sandbox',
          '--mount',
          `type=volume,src=${cliVolume},dst=/opt/swarmloop,readonly=true`,
          '--entrypoint',
          'sh',
          image,
          '-c',
          script,
        ],
        60_000,
      );
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).split('\n').slice(-3).join(' ').trim();
      throw new SwarmloopError(
        `${image}: the ${runtime} CLI does not start there (${detail}). Use a Debian or Ubuntu based image with bash; scripts/agent-env-probe.sh ${image} shows the reason.`,
      );
    }
    return out.includes('certs=yes');
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

  /** The setup runs in the project image with the package registries and no model key. Its output goes to the step log. */
  private async setup(
    input: { key: string; step: string; mounts: SandboxMount[] },
    launch: ProjectLaunch,
    command: string,
    mount: SandboxMount,
  ): Promise<{ exitCode: number; tail: string }> {
    const root = resolveRepoRoot(this.deps.env().SWARMLOOP_ROOT, __dirname);
    const userId = sandboxUserId();
    const statePath = agentStateDir(root, input.key, 'setup');
    const lines: string[] = [`$ ${command}`];
    let shown = 0;
    const show = (force = false) => {
      const now = this.clock.now();
      if (force || now - shown >= 1000) {
        shown = now;
        this.live?.log({ key: input.key, step: input.step, body: `${lines.slice(-200).join('\n')}\n` });
      }
    };
    show(true);
    const child = await this.sandbox.spawn({
      runtime: this.deps.env().RUNTIME,
      runKey: input.key,
      step: input.step,
      mounts: [mount, ...input.mounts.filter((item) => item !== mount)],
      statePath,
      allowHosts: setupHosts(),
      command: [],
      userId,
      project: { ...launch, shell: command },
    });
    let partial = '';
    const take = (chunk: Buffer) => {
      const text = partial + chunk.toString('utf8');
      const parts = text.split(/\r?\n/);
      partial = parts.pop() ?? '';
      lines.push(...parts);
      if (lines.length > 2000) {
        lines.splice(1, lines.length - 2000);
      }
      show();
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const exitCode = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        lines.push(`setup timed out after ${SETUP_TIMEOUT_MS / 60_000} min`);
        void this.sandbox.kill(child.containerName);
      }, SETUP_TIMEOUT_MS);
      child.once('error', (error: Error) => {
        clearTimeout(timer);
        lines.push(`docker could not start: ${error.message}`);
        resolve(1);
      });
      child.once('close', (code: number | null) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
    if (partial) {
      lines.push(partial);
    }
    lines.push(`exit ${exitCode}`);
    show(true);
    const directory = join(root, 'data');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${input.key}-setup-output.txt`), `${lines.join('\n')}\n`);
    return { exitCode, tail: lines.slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS) };
  }
}
