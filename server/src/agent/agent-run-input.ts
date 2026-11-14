import type { SandboxMount } from '../core/sandbox-mount';
import type { Effort } from '../contract/effort';
import type { RuntimeName } from '../integrations/agent-runtime/runtime-name';
import type { ManifestHosts, ProjectLaunch } from '../sandbox/sandbox-launch';

export interface AgentRunInput {
  prompt: string;
  workspace: string;
  outputFile: string;
  sessionFile: string;
  runtime: RuntimeName;
  model: string;
  /** How hard the agent works. Without it the runtime runs at its own default. */
  effort?: Effort;
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
  manifestHosts?: ManifestHosts;
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
  /** The line that closes every message the runner sends into the chat itself (continue, loop hint, background restart). */
  answerEnding?: string;
  /** The definition this prompt teaches the chat, persisted with its session metadata. */
  resultName?: string;
  /** Tells whether an answer holds what the step needs. Without it an answer is never treated as ended early. */
  answered?: (text: string) => boolean;
  /**
   * A watch on the agent's repeated commands. A pending `hint` or `end` kills the launch with reason `loop`.
   * `resumePrompt` takes a pending hint and returns the message for the same chat, or null when the stop is an end.
   */
  loop?: { pending(): 'hint' | 'end' | null; resumePrompt(): string | null };
  /** Called with each chunk of the agent's output as it arrives. */
  onOutput?: (chunk: string) => void;
  /** `onSuspended` gets the length of a host suspension that is not counted. `onLaunchEnd` runs when a launch ends, whatever the reason. */
  onSuspended?: (ms: number) => void;
  onLaunchEnd?: () => void;
  /** Run in the project image with the CLI mounted into it, instead of the agent image. */
  project?: ProjectLaunch;
}
