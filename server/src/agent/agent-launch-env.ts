import { join } from 'path';
import type { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import type { Clock } from '../core/clock';
import { CodexAuthStore, codexAuthDeps } from '../integrations/agent-runtime/codex/codex-auth';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import { modelCredential } from '../sandbox/sandbox-launch';

/** The env one agent launch hands to its container: the model credential of its runtime. */
export class AgentLaunchEnv {
  private codexAuth: CodexAuthStore | null = null;

  constructor(private readonly clock: Clock) {}

  /** The env entry that carries the runtime's model credential. */
  async credential(runtime: RuntimeName, env: AppConfig['env']): Promise<{ name: string; value: string }> {
    return modelCredential(
      runtime,
      env.CURSOR_API_KEY,
      env.ANTHROPIC_API_KEY,
      env.CLAUDE_CODE_OAUTH_TOKEN,
      await this.codexLogin(runtime, env),
      env.CODEX_API_KEY,
    );
  }

  /** The subscription login, refreshed once by the server so parallel containers never race on it. */
  private async codexLogin(runtime: RuntimeName, env: AppConfig['env']): Promise<string> {
    if (runtime !== 'codex' || env.CODEX_AUTH === '') {
      return env.CODEX_AUTH;
    }
    const dir = join(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), 'data', 'codex');
    this.codexAuth ??= new CodexAuthStore(dir, codexAuthDeps(this.clock));
    return this.codexAuth.current(env.CODEX_AUTH);
  }
}
