import type { PricedRequest } from './request-usage';
import type { ChatUsage } from './since-recorded';
import type { SandboxMount } from '../core/sandbox-mount';
import type { Effort } from '../contract/effort';
import type { AgentHelper } from '../integrations/agent-runtime/agent-runtime';
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
  /** A read-only helper on another model of the same runtime, inside this launch. */
  helper?: AgentHelper;
  agentCalls: number;
  spentUsd: number;
  resumeChatId: string | null;
  runKey: string;
  /** The key of the chat this launch continues when it is not its own key. Only the chat's files use it. */
  chatKey?: string;
  /** The login whose credential the launch uses. Without it the run's starter is looked up. */
  login?: string | null;
  step: string;
  attemptId: string;
  liveStep?: string;
  mounts: SandboxMount[];
  allowHosts?: string[];
  manifestHosts?: ManifestHosts;
  mode?: string;
  timeLimitMs?: number;
  auto?: boolean;
  /** The chat's previous reported session totals. A session total is taken against them. */
  prior?: ChatUsage;
  /** What the chat already cost: its stored visits and the earlier launches of this attempt. */
  chatSpentUsd?: number;
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
  /**
   * Called when what the agent start waits for changes before its first output: it waits for the pause or a place, and
   * once more when the spawn is over. The launch awaits each call.
   */
  onStartWait?: () => Promise<void>;
  /** `onLaunchEnd` runs when a launch ends, whatever the reason. */
  onLaunchEnd?: () => void;
  /** Called with each model request as it streams, priced at the launch's table. A repeated message id comes again with its latest usage. */
  onRequest?: (request: PricedRequest) => void;
  /** Run in the project image with the CLI mounted into it, instead of the agent image. */
  project?: ProjectLaunch;
}
