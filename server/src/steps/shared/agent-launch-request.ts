import type { AgentTools } from '../../integrations/agent-runtime/agent-runtime';
import type { EffortFields } from '../../contract/effort';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import type { Agent } from '../../config/agents';
import type { StateReason } from '../../contract/run-state';
import type { VisitDraft } from '../../history/visit';
import type { ResultDefinition } from '../../agent-result/result-definition';
import type { ManifestHosts, ProjectLaunch } from '../../sandbox/sandbox-launch';
import type { Tie } from '../../history/agent-call';

/**
 * Whose spend and visits a launch counts: a run, or any other owner with the same facts (the backlog planner's turn).
 * A run leaves the optional members unset and its launch works as it always did.
 */
export interface LaunchOwner {
  id: number;
  agentCalls: number;
  spentUsd: number;
  activeAttempt: string | null;
  startedBy?: string | null;
  parentRunId?: number | null;
  /** The agents to use, in fallback order, instead of the role list of the run's tier. */
  roleAgents?: Agent[];
  /** Records a launch that hit a provider limit, instead of a visit row of the run. */
  recordLimit?: (visit: VisitDraft) => Promise<void>;
  /** Stores what an agent start of this owner waits for (null: nothing), instead of the state of a run. */
  recordStartWait?: (wait: StateReason | null) => Promise<void>;
}

/** What a caller says of its call. Everything else the log records comes from the run key. */
export interface CallContextHints {
  /** Why the call is made, when the step's name does not say: an answer to a part, a person or a reviewer, a merge look. */
  purpose?: string;
  /** The tasks, runs and epics the call is tied to. It gives the ties its events name when the call's row opens (no value), and adds the ones its validated result names. */
  ties?: (resultValue: unknown) => Promise<Tie[]>;
}

export interface AgentLaunchRequest extends EffortFields {
  root: string;
  run: LaunchOwner;
  /** The login whose credential the launch uses. Without it the run's starter is looked up. */
  login?: string | null;
  key: string;
  /** The key of the chat this launch continues when it is not its own key. Only the chat's files use it. */
  chatKey?: string;
  step: string;
  mode: string;
  tools: AgentTools;
  runtime: RuntimeName;
  model: string;
  timeLimitMs: number;
  prompt: string;
  workspace: string;
  mounts: SandboxMount[];
  liveStep?: string;
  allowHosts?: string[];
  manifestHosts?: ManifestHosts;
  auto?: boolean;
  resume?: boolean;
  /** The step whose session file the launch reads and writes, when it is not `step`'s: a one-off chat names one no step shares. */
  session?: string;
  continuePrompt?: string | null;
  /** The full prompt for a fresh chat when `prompt` is a follow-up and the CLI no longer has the chat. */
  freshPrompt?: string;
  /** The result block the answer must end with. A missing or invalid block gets up to two follow-ups in the same chat. */
  result?: ResultDefinition;
  /** Checks a validated result. Each message it returns goes into the follow-up like a schema error. */
  check?: (value: unknown) => string[] | Promise<string[]>;
  /** The errors of the answer an earlier visit of the step failed on: this launch starts by telling the agent. */
  answerErrors?: string[];
  project?: ProjectLaunch;
  /** The project launch for another runtime. A launch that moves to another agent mounts that agent's CLI. */
  projectFor?: (runtime: RuntimeName) => Promise<ProjectLaunch | undefined>;
  /** Read-only helpers by runtime. The launch uses the first entry of the runtime that runs. */
  helpers?: readonly Agent[];
  /** The launch may move to the next agent of its role when its runtime hits a provider limit. */
  failover?: boolean;
  /** The full prompt for a new chat on another agent, when `prompt` is a follow-up. Defaults to `prompt`. */
  brief?: string;
  /** The full prompt for a new chat on the given runtime. Defaults to `brief`. */
  briefFor?: (runtime: RuntimeName) => string;
  /** What the log records of the call beyond what the request already says. */
  call?: CallContextHints;
}
