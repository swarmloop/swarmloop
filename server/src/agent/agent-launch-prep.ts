import { join } from 'path';
import type { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import type { LiveHub } from '../live/live.hub';
import type { AgentRuntime, AgentTools } from '../integrations/agent-runtime/agent-runtime';
import type { SandboxMount } from '../core/sandbox-mount';
import { prepareRunTmp, runTmpDir } from '../sandbox/run-tmp';
import { agentStateDir, prepareStateDir, writeHomeFiles, sandboxUserId } from '../sandbox/sandbox-launch';
import type { AgentRunInput as BaseAgentRunInput } from './agent-run-input';
import { syncChatMode } from './chat-mode';
import { attachmentsDir } from '../history/run-paths';
import { sessionHome } from '../history/session-group';
import { RUN_LOGS_PATH, runLogMount } from '../core/run-logs';
import { attachmentsMount, briefMounts, spillPrompt } from './agent-args';
import { copySkillBriefs, SKILLS_DIR } from './skill-briefs';

/** What one launch needs before it is spawned. */
interface Launch {
  userId: ReturnType<typeof sandboxUserId>;
  statePath: string;
  args: string[];
  /** Env names the container gets empty, so an inherited value never reaches the CLI. */
  unsetEnv: string[];
  /** The launch's own mounts: its briefs and this run's read-only log folder. */
  mounts: SandboxMount[];
}

type LaunchInput = BaseAgentRunInput & { tools: AgentTools };

/** Everything one agent launch needs before it is spawned: its state directory, and prompt delivery. */
export class AgentLaunchPrep {
  constructor(
    private readonly config: AppConfig,
    private readonly live?: LiveHub,
  ) {}

  /**
   * The /tmp of a project container: the folder of the chat it continues, kept when the launch resumes a chat id
   * and emptied when it starts a new chat. Empty for a container that runs no project command.
   */
  async runTmp(input: LaunchInput): Promise<{ tmp?: SandboxMount }> {
    if (!input.project) {
      return {};
    }
    const root = resolveRepoRoot(this.config.env.SWARMLOOP_ROOT, __dirname);
    const path = runTmpDir(root, input.runKey, sessionHome(input.step));
    return { tmp: await prepareRunTmp(path, sandboxUserId(), !input.resumeChatId) };
  }

  /** Prepares the state directory, chat mode, prompt delivery, and arguments for one launch. */
  prepare(input: LaunchInput, runtime: AgentRuntime, resumed: boolean): Launch {
    const userId = sandboxUserId();
    const root = resolveRepoRoot(this.config.env.SWARMLOOP_ROOT, __dirname);
    const statePath = agentStateDir(root, input.runKey, sessionHome(input.step));
    prepareStateDir(statePath, userId);
    writeHomeFiles(runtime.homeFiles(), statePath, userId);
    if (runtime.syncsChatMode && input.resumeChatId) {
      syncChatMode(statePath, input.resumeChatId, input.mode);
    }
    const delivered = spillPrompt(input.prompt, statePath, input.step);
    const briefs = briefMounts(statePath, input.step, delivered.mounts);
    if (briefs.length > 0) {
      copySkillBriefs(SKILLS_DIR, join(statePath, 'briefs'));
    }
    let args = [
      ...(briefs.length > 0 ? runtime.briefArgs() : []),
      ...runtime.readDirArgs(RUN_LOGS_PATH),
      ...runtime.printArgs({ ...input, prompt: delivered.text }),
    ];
    let unsetEnv: string[] = [];
    if (input.effort) {
      ({ args, unsetEnv } = runtime.withEffort({ model: input.model, args, unsetEnv }, input.effort));
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
    const files = attachmentsMount(attachmentsDir(this.config, input.runKey));
    const mounts = [...briefs, ...(files ? [files] : []), runLogMount(root, input.runKey)];
    return { userId, statePath, args, unsetEnv, mounts };
  }
}
