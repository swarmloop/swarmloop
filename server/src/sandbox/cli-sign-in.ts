import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { modelApiHosts, sandboxUserId } from './sandbox-launch';
import { SandboxService } from './sandbox.service';
import { worktreesMount } from './worktrees-mount';

/** Only the tail of the output is kept: the part that has the link, the code or the end. */
const OUTPUT_CAP = 64 * 1024;
const ESCAPES = new RegExp(String.raw`\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*\u0007)`, 'g');

interface CliSignInRequest {
  runtime: string;
  command: string[];
  /** The hosts the CLI needs beyond the runtime's API hosts. */
  hosts: string[];
  /** Names the container, so two sign-ins never share one. */
  key: string;
}

/** One CLI that runs in the agent image. It holds no credential and keeps stdin open for the person's code. */
export interface CliSignInRun {
  /** Everything the CLI printed, without terminal escapes, the last 64 KB. */
  output(): string;
  /** Writes to the CLI's stdin. */
  write(text: string): void;
  /** The exit code, or null when the CLI could not run. */
  exited: Promise<number | null>;
  /** Ends stdin and removes the container. Safe to call again. */
  stop(): Promise<void>;
}

/** Runs the command of a sign-in in the runtime's agent image. The command and how to read it come from the adapter. */
@Injectable()
export class CliSignIn {
  constructor(
    private readonly config: AppConfig,
    private readonly sandbox: SandboxService,
  ) {}

  async run(request: CliSignInRequest): Promise<CliSignInRun> {
    const root = resolveRepoRoot(this.config.env.SWARMLOOP_ROOT, __dirname);
    const runtime = runtimeFor(request.runtime).name;
    const child = await this.sandbox.spawn({
      runtime,
      runKey: 'sign-in',
      step: `sign-in-${runtime}-${request.key}`,
      attemptId: '',
      mounts: [worktreesMount(root)],
      allowHosts: [...modelApiHosts(runtime), ...request.hosts],
      command: request.command,
      userId: sandboxUserId(),
      stdin: true,
    });
    let printed = '';
    const take = (chunk: Buffer) => {
      printed = (printed + chunk.toString('utf8')).slice(-OUTPUT_CAP);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    let stopped: Promise<void> | null = null;
    const stop = () => {
      stopped ??= (async () => {
        child.stdin?.end();
        await this.sandbox.remove(child.containerName);
      })();
      return stopped;
    };
    const exited = new Promise<number | null>((resolve) => {
      child.once('error', (error: Error) => {
        take(Buffer.from(`\n${error.message}`));
        void stop().then(() => resolve(null));
      });
      child.once('close', (code: number | null) => {
        void stop().then(() => resolve(code));
      });
    });
    return {
      output: () => printed.replace(ESCAPES, ''),
      write: (text) => void child.stdin?.write(text),
      exited,
      stop,
    };
  }
}
