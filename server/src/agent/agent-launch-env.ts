import { join } from 'path';
import type { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import type { Clock } from '../core/clock';
import { CodexAuthStore, codexAuthDeps } from '../integrations/agent-runtime/codex/codex-auth';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';

/** The credential a launch resolved: the env entry, and the login it belongs to (null for the server's env). */
interface LaunchCredential {
  name: string;
  value: string;
  owner: string | null;
}

/** The env one agent launch hands to its container: the model credential of its runtime. */
export class AgentLaunchEnv {
  private codexAuth: CodexAuthStore | null = null;

  constructor(private readonly clock: Clock) {}

  /** The env entry that carries the runtime's model credential. */
  async credential(
    runtime: RuntimeName,
    credential: LaunchCredential,
    env: AppConfig['env'],
  ): Promise<{ name: string; value: string }> {
    return { name: credential.name, value: await this.codexLogin(runtime, credential, env) };
  }

  /** The subscription login, refreshed once by the server so parallel containers never race on it. */
  private async codexLogin(runtime: RuntimeName, credential: LaunchCredential, env: AppConfig['env']): Promise<string> {
    if (runtime !== 'codex' || credential.name !== 'CODEX_AUTH') {
      return credential.value;
    }
    const dir = join(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), 'data', 'codex');
    this.codexAuth ??= new CodexAuthStore(dir, codexAuthDeps(this.clock));
    return this.codexAuth.current(credential.value, credential.owner ?? 'env');
  }
}
