import type { Effort } from '../../contract/effort';
import type { LimitHit, LimitInput } from './runtime-limit';
import type { RuntimeName } from './runtime-name';

export type { RuntimeName };

export interface RuntimeKeys {
  cursorKey: string;
  anthropicKey: string;
  oauthToken: string;
  codexAuth: string;
  codexApiKey: string;
}

/** `read` leaves a step the tools that read; `plan` leaves those plus skills; `write` leaves it every tool but the ones no print-mode turn can use. */
export type AgentTools = 'read' | 'plan' | 'write';

export interface AgentPrintInput {
  model: string;
  prompt: string;
  mounts: readonly { containerPath: string }[];
  resumeChatId: string | null;
  mode?: string;
  tools: AgentTools;
  approveMcps?: boolean;
}

/** A file a launch needs in the CLI home, relative to the state directory. */
export interface HomeFile {
  path: string;
  content: string;
  mode: number;
}

export interface AgentTerminalInput {
  model: string;
  workspace: string;
  resumeChatId: string | null;
  vendor: string[];
}

/** What the container gets when the egress proxy holds the key: a placeholder, and how the proxy sends the real one. */
export interface EgressCredential {
  env: { name: string; value: string }[];
  /** Arguments that go right after the CLI name, such as a base URL the CLI reads only from its flags. */
  args?: string[];
  /** The model API the proxy calls with the real key. Absent when the key has to stay in the container. */
  api?: { upstream: string; header: string; value: string };
}

/** The parts of a launch a level can change: the model id, the CLI arguments and the env names to clear. */
export interface EffortLaunch {
  model: string;
  args: string[];
  unsetEnv: string[];
}

export interface AgentRuntime {
  readonly name: RuntimeName;
  readonly command: 'agent' | 'claude' | 'codex';
  /** The image component this CLI runs in. Where the image comes from is the resolver's business. */
  readonly component: `agent-${RuntimeName}`;
  readonly apiHosts: readonly string[];
  readonly credentialNames: readonly string[];
  readonly syncsChatMode: boolean;
  /** True when the plan mode of this CLI has a tool that takes the checklist. */
  readonly planModeHasPlanTool: boolean;
  readonly priceSource: string;
  credential(keys: RuntimeKeys): { name: string; value: string };
  /** The provider limit the end of a launch reports, or null when it is no limit: an auth, billing, network or context error is none. */
  classifyLimit(input: LimitInput): LimitHit | null;
  /** The rule file names the CLI loads by itself from its working directory. */
  ownRuleFiles(): readonly string[];
  briefArgs(): string[];
  printArgs(input: AgentPrintInput): string[];
  terminalArgs(input: AgentTerminalInput): string[];
  /** Files written into the CLI home before every print launch. */
  homeFiles(): HomeFile[];
  /** The levels this CLI supports for a model. None when it has no way to set one. */
  efforts(model: string): readonly Effort[];
  /** The launch with the level applied to arguments that are already built. */
  withEffort(launch: EffortLaunch, level: Effort): EffortLaunch;
  /** The CLI arguments that print its model ids, or null when the levels do not depend on a list. */
  modelListArgs(): string[] | null;
  /** Takes what the model list printed. A runtime whose levels do not depend on a list ignores it. */
  useModelList(output: string): void;
  /** The credential for a container behind the egress proxy. */
  egressCredential(credential: { name: string; value: string }, api: string): EgressCredential;
}
