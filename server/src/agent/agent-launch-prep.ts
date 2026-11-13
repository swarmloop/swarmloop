import { join } from 'path';
import type { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import type { LiveHub } from '../live/live.hub';
import type { Clock } from '../core/clock';
import type { AgentRuntime, AgentTools } from '../integrations/agent-runtime/agent-runtime';
import { CodexAuthStore, codexAuthDeps } from '../integrations/agent-runtime/codex/codex-auth';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import type { SandboxMount } from '../core/sandbox-mount';
import { agentStateDir, prepareStateDir, writeHomeFiles, sandboxUserId } from '../sandbox/sandbox-launch';
import type { AgentRunInput as BaseAgentRunInput } from './agent-run-input';
import { syncChatMode } from './chat-mode';
import { sessionHome } from '../history/session-group';
import { briefMounts, spillPrompt } from './agent-args';

/** What one launch needs before it is spawned. */
interface Launch {
  userId: ReturnType<typeof sandboxUserId>;
  statePath: string;
  args: string[];
  briefs: SandboxMount[];
}

type LaunchInput = BaseAgentRunInput & { tools: AgentTools };

/** Everything one agent launch needs before it is spawned: its state directory, prompt delivery and login. */
export class AgentLaunchPrep {
  private codexAuth: CodexAuthStore | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly live?: LiveHub,
  ) {}

  /** The subscription login, refreshed once by the server so parallel containers never race on it. */
  async codexLogin(runtime: RuntimeName, env: AppConfig['env']): Promise<string> {
    if (runtime !== 'codex' || env.CODEX_AUTH === '') {
      return env.CODEX_AUTH;
    }
    const dir = join(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), 'data', 'codex');
    this.codexAuth ??= new CodexAuthStore(dir, codexAuthDeps(this.clock));
    return this.codexAuth.current(env.CODEX_AUTH);
  }

  /** Prepares the state directory, chat mode, prompt delivery, and arguments for one launch. */
  prepare(input: LaunchInput, runtime: AgentRuntime, resumed: boolean): Launch {
    const userId = sandboxUserId();
    const statePath = agentStateDir(
      resolveRepoRoot(this.config.env.SWARMLOOP_ROOT, __dirname),
      input.runKey,
      sessionHome(input.step),
    );
    prepareStateDir(statePath, userId);
    writeHomeFiles(runtime.homeFiles(), statePath, userId);
    if (runtime.syncsChatMode && input.resumeChatId) {
      syncChatMode(statePath, input.resumeChatId, input.mode);
    }
    const delivered = spillPrompt(input.prompt, statePath, input.step);
    const briefs = briefMounts(statePath, input.step, delivered.mounts);
    const args = runtime.printArgs({ ...input, prompt: delivered.text });
    if (briefs.length > 0) {
      args.unshift(...runtime.briefArgs());
    }
    if (!resumed) {
      this.live?.log({
        key: input.runKey,
        step: input.liveStep ?? input.step,
        body: 'waiting for output\n',
        samples: [],
        usage: { tokensIn: 0, tokensOut: 0, usd: 0 },
      });
    }
    return { userId, statePath, args, briefs };
  }
}
