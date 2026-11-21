import { join } from 'path';
import type { SwarmloopEnv } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { startCommandSpan } from '../core/step-event-scope';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime';
import { CliBundles } from '../sandbox/cli-bundle';
import type { ProjectLaunch } from '../sandbox/sandbox-launch';
import { prepareStateDir, sandboxUserId } from '../sandbox/sandbox-launch';
import type { SandboxService } from '../sandbox/sandbox.service';
import { runProbe } from './image-probe';
import { projectSlug } from './project-image';

interface LaunchDeps {
  env: () => Pick<SwarmloopEnv, 'SWARMLOOP_ROOT'>;
  sandbox: Pick<SandboxService, 'run' | 'spawn' | 'kill' | 'stateDaemonPath' | 'stats'>;
}

/** The pieces of an agent launch that do not depend on the run: the CLI volume, the image probe and the caches. */
export class ProjectLaunches {
  private readonly bundles: CliBundles;
  private readonly probed = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: LaunchDeps) {
    this.bundles = new CliBundles((args, timeoutMs) => this.deps.sandbox.run(args, timeoutMs));
  }

  /** The CLI volume of the agent image. */
  async cliBundle(runtime: RuntimeName, agentRef: string): Promise<string> {
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

  /** Once per image and CLI: does the CLI start there, and does the image bring its own CA bundle. */
  probe(image: string, cliVolume: string, runtime: RuntimeName): Promise<boolean> {
    const key = `${image}\0${cliVolume}`;
    let found = this.probed.get(key);
    if (!found) {
      found = runProbe(this.deps.sandbox, image, cliVolume, runtime).catch((error: unknown) => {
        this.probed.delete(key);
        throw error;
      });
      this.probed.set(key, found);
    }
    return found;
  }

  async caches(repo: string, paths: string[]): Promise<ProjectLaunch['caches']> {
    const root = resolveRepoRoot(this.deps.env().SWARMLOOP_ROOT, __dirname);
    const userId = sandboxUserId();
    const caches: ProjectLaunch['caches'] = [];
    for (const containerPath of paths) {
      const dir = join(root, 'data', 'env-cache', projectSlug(repo), containerPath.slice(1).replace(/\//g, '-'));
      prepareStateDir(dir, userId);
      caches.push({ containerPath, daemonPath: (await this.deps.sandbox.stateDaemonPath(dir)) ?? dir });
    }
    return caches;
  }
}
