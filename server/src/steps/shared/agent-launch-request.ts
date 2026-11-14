import type { AgentTools } from '../../integrations/agent-runtime/agent-runtime';
import type { EffortFields } from '../../contract/effort';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import type { RunEntity } from '../../history/entities';
import type { ResultDefinition } from '../../agent-result/result-definition';
import type { ManifestHosts, ProjectLaunch } from '../../sandbox/sandbox-launch';

export interface AgentLaunchRequest extends EffortFields {
  root: string;
  run: RunEntity;
  key: string;
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
  approveMcps?: boolean;
  auto?: boolean;
  resume?: boolean;
  continuePrompt?: string | null;
  /** The full prompt for a fresh chat when `prompt` is a follow-up and the CLI no longer has the chat. */
  freshPrompt?: string;
  /** The result block the answer must end with. A missing or invalid block gets up to two follow-ups in the same chat. */
  result?: ResultDefinition;
  /** Checks a validated result. Each message it returns goes into the follow-up like a schema error. */
  check?: (value: unknown) => string[];
  /** The errors of the answer an earlier visit of the step failed on: this launch starts by telling the agent. */
  answerErrors?: string[];
  project?: ProjectLaunch;
  /** The project launch for another runtime. A launch that moves to another agent mounts that agent's CLI. */
  projectFor?: (runtime: RuntimeName) => Promise<ProjectLaunch | undefined>;
  /** The launch may move to the next agent of its role when its runtime hits a provider limit. */
  failover?: boolean;
  /** The full prompt for a new chat on another agent, when `prompt` is a follow-up. Defaults to `prompt`. */
  brief?: string;
  /** The full prompt for a new chat on the given runtime. Defaults to `brief`. */
  briefFor?: (runtime: RuntimeName) => string;
}
