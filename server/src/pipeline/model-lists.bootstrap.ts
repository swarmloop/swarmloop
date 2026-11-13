import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { sandboxModelLister } from '../agent/model-list';
import { warmModelLists } from '../agent/runtime-model-lists';
import { credentialFor } from '../config/agents';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { Clock } from '../core/clock';
import { SandboxService } from '../sandbox/sandbox.service';

/**
 * Gives each runtime its model list before agents are resolved: the root, the `worktrees` mount and the lister are the
 * same in every process. Only runtimes whose env agents name a level read their CLI.
 */
export async function warmRuntimeModelLists(
  env: AppConfig['env'],
  sandbox: SandboxService,
  clock: Clock,
): Promise<void> {
  const root = resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname);
  const mount = { hostPath: join(root, 'worktrees'), containerPath: '/work' };
  mkdirSync(mount.hostPath, { recursive: true });
  await warmModelLists(env, root, clock.now(), (runtime) =>
    sandboxModelLister(sandbox, runtime, credentialFor(env, runtime.name), mount),
  );
}

/** The CLI process resolves agents too, so it reads the model lists the levels depend on before a command runs. */
@Injectable()
export class ModelListsBootstrap implements OnApplicationBootstrap {
  constructor(
    private readonly config: AppConfig,
    private readonly sandbox: SandboxService,
    private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await warmRuntimeModelLists(this.config.env, this.sandbox, this.clock);
  }
}
