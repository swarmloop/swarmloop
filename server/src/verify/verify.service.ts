import { join } from 'path';
import { Injectable } from '@nestjs/common';
import { resolveRepoRoot } from '../config/repo-root';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import {
  agentStateDir,
  containerName,
  packageRegistries,
  prepareStateDir,
  sandboxNetworkName,
  sandboxUserId,
} from '../sandbox/sandbox-launch';
import { collectEnvMasks, SandboxService } from '../sandbox/sandbox.service';
import { ReadManifest, readManifest, SwarmloopManifest } from './manifest';
import { LineBuffer, Tail } from './verify-output';
import { VerifyCache, verifyArgs, VerifyLaunch, VerifyPhase } from './verify-args';
import { projectSlug, resolveVerifyImage } from './verify-image';
import { changedSince, createdSince, worktreeState } from './verify-worktree';

export interface VerifyRunInput {
  runKey: string;
  project: string;
  worktree: string;
  baseRef: string;
  signal?: AbortSignal;
  onOutput?: (line: VerifyOutputLine) => void;
}

export interface VerifyOutputLine {
  command: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface VerifyCommandResult {
  command: string;
  exitCode: number;
  tail: string;
}

export type VerifyResult =
  | { status: 'skipped' }
  | {
      status: 'ok' | 'failed' | 'error';
      commands: VerifyCommandResult[];
      warnings: string[];
      /** Tracked files that `install` wrote, typically a lockfile. They stay in the worktree. */
      installChanged: string[];
      durationMs: number;
      message?: string;
    };

type BaseLaunch = Omit<VerifyLaunch, 'phase' | 'command'>;
type Outcome = { kind: 'exit'; code: number; tail: string } | { kind: 'stopped'; message: string };

@Injectable()
export class VerifyService {
  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly sandbox: SandboxService,
  ) {}

  async run(input: VerifyRunInput): Promise<VerifyResult> {
    const started = this.clock.now();
    let loaded: ReadManifest | null;
    try {
      loaded = await readManifest(input.worktree, input.baseRef);
    } catch (error) {
      return this.result(started, 'error', { message: errorText(error) });
    }
    if (!loaded) {
      return { status: 'skipped' };
    }
    const { manifest, warnings } = loaded;
    let base: BaseLaunch;
    try {
      base = await this.prepare(input, manifest);
    } catch (error) {
      return this.result(started, 'error', { warnings, message: errorText(error) });
    }
    try {
      return await this.runAll(input, manifest, base, started, warnings);
    } catch (error) {
      return this.result(started, 'error', { warnings, message: errorText(error) });
    }
  }

  private async prepare(input: VerifyRunInput, manifest: SwarmloopManifest): Promise<BaseLaunch> {
    const root = resolveRepoRoot(this.config.env.SWARMLOOP_ROOT, __dirname);
    const userId = sandboxUserId();
    const image = await resolveVerifyImage({
      docker: (args, timeoutMs) => this.sandbox.run(args, timeoutMs),
      repoPath: input.worktree,
      baseRef: input.baseRef,
      project: input.project,
      manifest,
    });
    const caches: VerifyCache[] = [];
    for (const containerPath of manifest.cache ?? []) {
      const slug = containerPath.slice(1).replace(/\//g, '-');
      const dir = join(root, 'data', 'verify-cache', projectSlug(input.project), slug);
      prepareStateDir(dir, userId);
      caches.push({ containerPath, daemonPath: (await this.sandbox.stateDaemonPath(dir)) ?? dir });
    }
    const [worktree] = await this.sandbox.withDaemonPaths([{ hostPath: input.worktree, containerPath: '/work' }]);
    if (!worktree) {
      throw new Error('verify worktree is missing');
    }
    const envMasks = collectEnvMasks([worktree]);
    const maskFile = await this.sandbox.maskFor(agentStateDir(root, input.runKey, 'verify'), envMasks.length > 0);
    return { runKey: input.runKey, image, worktree, caches, envMasks, maskFile, userId };
  }

  private async runAll(
    input: VerifyRunInput,
    manifest: SwarmloopManifest,
    base: BaseLaunch,
    started: number,
    warnings: string[],
  ): Promise<VerifyResult> {
    const deadline = started + manifest.timeoutMin * 60_000;
    const commands: VerifyCommandResult[] = [];
    const before = await worktreeState(input.worktree);
    let installChanged: string[] = [];
    let status: 'ok' | 'failed' | 'error' = 'ok';
    let message: string | undefined;
    const steps: { phase: VerifyPhase; command: string }[] = [
      ...(manifest.install ? [{ phase: 'install' as const, command: manifest.install }] : []),
      ...manifest.verify.map((command) => ({ phase: 'verify' as const, command })),
    ];
    try {
      if (manifest.install) {
        await this.sandbox.ensureNetwork(sandboxNetworkName(packageRegistries()) ?? '', false);
      }
      for (const step of steps) {
        const args = verifyArgs({ ...base, ...step });
        const outcome = await this.runCommand(input, args, step.command, deadline, manifest.timeoutMin);
        if (outcome.kind === 'stopped') {
          status = 'error';
          message = outcome.message;
          break;
        }
        commands.push({ command: step.command, exitCode: outcome.code, tail: outcome.tail });
        if (step.phase === 'install') {
          installChanged = changedSince(before, await worktreeState(input.worktree));
        }
        if (outcome.code !== 0) {
          status = 'failed';
          message = `${step.command} exited ${outcome.code}`;
          break;
        }
      }
    } catch (error) {
      status = 'error';
      message = errorText(error);
    }
    const created = createdSince(before, await worktreeState(input.worktree));
    if (created.length > 0) {
      const text = `verify created files that git does not ignore: ${created.join(', ')}; add them to .gitignore`;
      message = message ? `${message}; ${text}` : text;
      status = status === 'ok' ? 'failed' : status;
    }
    return this.result(started, status, { commands, warnings, installChanged, message });
  }

  /** Runs one container and streams its output. Ends it when the deadline passes or the run is stopped. */
  private async runCommand(
    input: VerifyRunInput,
    args: string[],
    command: string,
    deadline: number,
    timeoutMin: number,
  ): Promise<Outcome> {
    const name = containerName(input.runKey, 'verify');
    const remaining = deadline - this.clock.now();
    if (input.signal?.aborted) {
      return { kind: 'stopped', message: 'verify was stopped' };
    }
    if (remaining <= 0) {
      return { kind: 'stopped', message: `verify timed out after ${timeoutMin} min` };
    }
    const emit = (stream: VerifyOutputLine['stream'], text: string) => input.onOutput?.({ command, stream, text });
    const tail = new Tail();
    const lines = (stream: VerifyOutputLine['stream']) =>
      new LineBuffer((text) => {
        tail.add(text);
        emit(stream, text);
      });
    const out = lines('stdout');
    const err = lines('stderr');
    const began = this.clock.now();
    await this.sandbox.remove(name);
    emit('stdout', `$ ${command}`);
    const child = this.sandbox.spawnDocker(args);
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    return new Promise<Outcome>((resolve) => {
      let settled = false;
      let stopMessage: string | null = null;
      const end = (outcome: Outcome) => {
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const stop = (message: string) => {
        stopMessage ??= message;
        void this.sandbox.kill(name).then(() => {
          if (!settled) {
            end({ kind: 'stopped', message: stopMessage ?? message });
          }
        });
      };
      const onAbort = () => stop('verify was stopped');
      const timer = setTimeout(() => stop(`verify timed out after ${timeoutMin} min`), remaining);
      input.signal?.addEventListener('abort', onAbort, { once: true });
      child.once('error', (error: Error) =>
        end({ kind: 'stopped', message: `docker could not start: ${error.message}` }),
      );
      child.once('close', (code: number | null) => {
        if (settled) {
          return;
        }
        if (stopMessage) {
          end({ kind: 'stopped', message: stopMessage });
          return;
        }
        out.flush();
        err.flush();
        const exitCode = code ?? 1;
        emit('stdout', `exit ${exitCode} (${Math.round((this.clock.now() - began) / 1000)}s)`);
        end({ kind: 'exit', code: exitCode, tail: tail.text() });
      });
    });
  }

  private result(
    started: number,
    status: 'ok' | 'failed' | 'error',
    fields: { commands?: VerifyCommandResult[]; warnings?: string[]; installChanged?: string[]; message?: string },
  ): VerifyResult {
    return {
      status,
      commands: fields.commands ?? [],
      warnings: fields.warnings ?? [],
      installChanged: fields.installChanged ?? [],
      durationMs: this.clock.now() - started,
      ...(fields.message === undefined ? {} : { message: fields.message }),
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
