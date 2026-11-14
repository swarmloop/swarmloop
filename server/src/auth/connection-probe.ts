import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { sandboxModelLister, saveModelList } from '../agent/model-list';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { Clock } from '../core/clock';
import { SwarmloopError } from '../core/swarmloop-error';
import type { ConnectionProbe } from '../integrations/connection';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { modelApiHosts, sandboxUserId } from '../sandbox/sandbox-launch';
import { SandboxService } from '../sandbox/sandbox.service';
import { worktreesMount } from '../sandbox/worktrees-mount';
import { NO_KEYS } from './personal-credentials.service';

/** A test of a credential answers at once, so a request that hangs ends after this long. */
const REQUEST_TIMEOUT_MS = 15_000;
/** A command in the agent image takes longer to start than a request, so its limit is longer. */
const CHECK_TIMEOUT_MS = 60_000;

/** The real calls a connection test makes: a model list in the agent image, and one plain HTTP read. */
@Injectable()
export class SandboxConnectionProbe implements ConnectionProbe {
  constructor(
    private readonly config: AppConfig,
    private readonly sandbox: SandboxService,
    private readonly clock: Clock,
  ) {}

  /** Lists the models a key can use. A list that came back is cached for the Settings menu, as the boot warm-up does. */
  async listModels(runtimeName: string, fields: Record<string, string>): Promise<string[]> {
    const runtime = runtimeFor(runtimeName);
    if (runtime.modelListArgs() === null) {
      throw new SwarmloopError('this runtime lists no models');
    }
    const root = resolveRepoRoot(this.config.env.SWARMLOOP_ROOT, __dirname);
    const mount = worktreesMount(root);
    const credential = runtime.credential({ ...NO_KEYS, ...fields });
    const output = await sandboxModelLister(this.sandbox, runtime, credential, mount)();
    if (output.trim() !== '') {
      await saveModelList(root, runtime, this.clock.now(), output);
    }
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** Runs a command once in the agent image with the credential env. Stdout and stderr are the output. */
  async check(
    runtimeName: string,
    env: { name: string; value: string }[],
    command: string[],
  ): Promise<{ ok: boolean; output: string }> {
    const root = resolveRepoRoot(this.config.env.SWARMLOOP_ROOT, __dirname);
    const runtime = runtimeFor(runtimeName).name;
    const child = await this.sandbox.spawn({
      runtime,
      runKey: 'connection-check',
      step: `check-${runtime}-${randomUUID()}`,
      attemptId: '',
      mounts: [worktreesMount(root)],
      allowHosts: modelApiHosts(runtime),
      env,
      command,
      userId: sandboxUserId(),
    });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new SwarmloopError('the check timed out')), CHECK_TIMEOUT_MS);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (exit: number | null) => {
          clearTimeout(timer);
          resolve(exit);
        });
      });
      return { ok: code === 0, output: Buffer.concat(chunks).toString('utf8').trim() };
    } finally {
      await this.sandbox.remove(child.containerName);
    }
  }

  async request(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { status: response.status, body: await response.text() };
  }
}
