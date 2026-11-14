import { Injectable } from '@nestjs/common';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { sandboxModelLister, saveModelList } from '../agent/model-list';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { Clock } from '../core/clock';
import { SwarmloopError } from '../core/swarmloop-error';
import type { ConnectionProbe } from '../integrations/connection';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { SandboxService } from '../sandbox/sandbox.service';
import { NO_KEYS } from './personal-credentials.service';

/** A test of a credential answers at once, so a request that hangs ends after this long. */
const REQUEST_TIMEOUT_MS = 15_000;

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
    const mount = { hostPath: join(root, 'worktrees'), containerPath: '/work' };
    mkdirSync(mount.hostPath, { recursive: true });
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

  async request(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { status: response.status, body: await response.text() };
  }
}
