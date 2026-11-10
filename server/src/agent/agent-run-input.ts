import type { SandboxMount } from '../core/sandbox-mount';
import type { RuntimeName } from '../integrations/agent-runtime/runtime-name';
import type { ProjectLaunch } from '../sandbox/sandbox-launch';

export interface AgentRunInput {
  prompt: string;
  workspace: string;
  outputFile: string;
  sessionFile: string;
  runtime: RuntimeName;
  model: string;
  agentCalls: number;
  spentUsd: number;
  tokensInRun: number;
  resumeChatId: string | null;
  runKey: string;
  step: string;
  attemptId: string;
  liveStep?: string;
  mounts: SandboxMount[];
  allowHosts?: string[];
  mode?: string;
  timeLimitMs?: number;
  approveMcps?: boolean;
  auto?: boolean;
  /** Dollars already recorded for this chat. Used only when the CLI total is cumulative. */
  groupUsd?: number;
  /**
   * Prompt for another launch after a time or idle kill.
   * Null leaves that kill as the result. Omitted uses the shared default.
   */
  continuePrompt?: string | null;
  /** The full prompt for a fresh chat, when `prompt` is a follow-up that only a resumed chat can use. */
  freshPrompt?: string;
  /** Tells whether an answer holds what the step needs. Without it an answer is never treated as ended early. */
  answered?: (text: string) => boolean;
  /** Called with each chunk of the agent's output as it arrives. */
  onOutput?: (chunk: string) => void;
  /** `onSuspended` gets the length of a host suspension that is not counted. `onLaunchEnd` runs when a launch ends, whatever the reason. */
  onSuspended?: (ms: number) => void;
  onLaunchEnd?: () => void;
  /** Run in the project image with the CLI mounted into it, instead of the agent image. */
  project?: ProjectLaunch;
}
