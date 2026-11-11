import type { CODE_REVIEWERS, StepName } from '../contract/steps';
import { SwarmloopError } from '../core/swarmloop-error';
import { RUNTIME_NAMES, runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';

/** An agent is a runtime and the model it runs. It is written `runtime:model`. */
interface Agent {
  runtime: RuntimeName;
  model: string;
}

const ROLES = ['plan', 'implement', 'review'] as const;
type Role = (typeof ROLES)[number];

/** A run with a parent is a subtask and has its own agents. */
const TIERS = ['main', 'subtask'] as const;
type Tier = (typeof TIERS)[number];

/** The env values that name agents: the short form and the role lists. */
interface AgentEnv {
  RUNTIME: RuntimeName;
  MODEL_PLAN: string;
  MODEL_IMPLEMENT: string;
  AGENTS_PLAN: string;
  AGENTS_IMPLEMENT: string;
  AGENTS_REVIEW: string;
  AGENTS_SUBTASK_PLAN: string;
  AGENTS_SUBTASK_IMPLEMENT: string;
  AGENTS_SUBTASK_REVIEW: string;
}

/** What `agentFor` reads of a run: only a run with a parent is a subtask. */
type AgentRun = object & { parentRunId?: number | null };

/** Everything that launches or prices an agent: the steps of a run, and the work done outside the pipeline. */
type AgentUse =
  StepName | 'code-review-report' | `code-review-${(typeof CODE_REVIEWERS)[number]}` | 'chat' | 'shell' | 'rebase';

/** The one table from a step to its role. A step without an agent has none. */
export const ROLE_OF_STEP = {
  requirements: null,
  prepare: null,
  research: 'plan',
  plan: 'plan',
  'plan-improve': 'plan',
  branch: null,
  implement: 'implement',
  'implement-improve': 'implement',
  checks: null,
  'code-review': 'review',
  commit: null,
  'merge-request': 'plan',
  pipeline: null,
  done: null,
  'code-review-report': 'review',
  'code-review-requirements': 'review',
  'code-review-quality': 'review',
  'code-review-regressions': 'review',
  'code-review-security': 'review',
  'code-review-performance': 'review',
  chat: 'implement',
  shell: 'implement',
  rebase: 'implement',
} as const satisfies Record<AgentUse, Role | null>;

/** The uses that have an agent. */
type AgentUseName = {
  [K in keyof typeof ROLE_OF_STEP]: (typeof ROLE_OF_STEP)[K] extends null ? never : K;
}[keyof typeof ROLE_OF_STEP];

function roleFor(step: string): Role | null {
  return Object.hasOwn(ROLE_OF_STEP, step) ? ROLE_OF_STEP[step as AgentUse] : null;
}

/** An ordered, comma-separated list of `runtime:model`. The first agent runs; the rest are the fallback order. */
export function parseAgentList(name: string, text: string): Agent[] {
  const agents = text.split(',').map((item) => {
    const entry = item.trim();
    const colon = entry.indexOf(':');
    const runtime = colon < 0 ? entry : entry.slice(0, colon).trim();
    const model = colon < 0 ? '' : entry.slice(colon + 1).trim();
    const known = RUNTIME_NAMES.find((candidate) => candidate === runtime);
    if (!known) {
      throw new SwarmloopError(`${name} has unknown runtime "${runtime}" in agent "${entry}"`);
    }
    if (model === '') {
      throw new SwarmloopError(`${name} has an empty model in agent "${entry}"`);
    }
    return { runtime: known, model };
  });
  return agents;
}

const LISTS: Record<Tier, Record<Role, keyof AgentEnv>> = {
  main: { plan: 'AGENTS_PLAN', implement: 'AGENTS_IMPLEMENT', review: 'AGENTS_REVIEW' },
  subtask: { plan: 'AGENTS_SUBTASK_PLAN', implement: 'AGENTS_SUBTASK_IMPLEMENT', review: 'AGENTS_SUBTASK_REVIEW' },
};

/** The agents of one role in one tier, in fallback order. An unset list falls back to the main role, then to the short form. */
function agentsOf(env: AgentEnv, role: Role, tier: Tier = 'main'): Agent[] {
  for (const candidate of tier === 'subtask' ? [tier, 'main' as const] : [tier]) {
    const name = LISTS[candidate][role];
    if (env[name] !== '') {
      return parseAgentList(name, env[name]);
    }
  }
  return [{ runtime: env.RUNTIME, model: role === 'implement' ? env.MODEL_IMPLEMENT : env.MODEL_PLAN }];
}

/** The agent a step runs on, or null when the step has none. The only place that maps a step to a role and an agent. */
export function agentFor(env: AgentEnv, run: AgentRun | null, step: AgentUseName): Agent;
export function agentFor(env: AgentEnv, run: AgentRun | null, step: string): Agent | null;
export function agentFor(env: AgentEnv, run: AgentRun | null, step: string): Agent | null {
  const role = roleFor(step);
  return role ? agentsOf(env, role, tierOf(run))[0] : null;
}

/** Every agent of a step's role and tier, in fallback order. Empty for a step without an agent. */
export function agentsFor(env: AgentEnv, run: AgentRun | null, step: string): Agent[] {
  const role = roleFor(step);
  return role ? agentsOf(env, role, tierOf(run)) : [];
}

/**
 * The first agent of a step's role and tier whose runtime is not cooling down after a provider limit, or null when
 * every one is. The first agent comes back as soon as its cooldown ends, so no step stays on a fallback.
 */
export function availableAgent(
  env: AgentEnv,
  run: AgentRun | null,
  step: string,
  cooling: ReadonlySet<string>,
): Agent | null {
  return agentsFor(env, run, step).find((agent) => !cooling.has(agent.runtime)) ?? null;
}

function tierOf(run: AgentRun | null): Tier {
  return run?.parentRunId ? 'subtask' : 'main';
}

/** The role and tier of a step, for the line the step window shows. */
export function roleOf(run: AgentRun | null, step: string): { role: Role; tier: Tier } | null {
  const role = roleFor(step);
  return role ? { role, tier: tierOf(run) } : null;
}

/** Every distinct runtime named in any role of any tier. */
export function runtimesInUse(env: AgentEnv): RuntimeName[] {
  const all = TIERS.flatMap((tier) => ROLES.flatMap((role) => agentsOf(env, role, tier)));
  return [...new Set(all.map((agent) => agent.runtime))];
}

interface CredentialEnv {
  CURSOR_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  CLAUDE_CODE_OAUTH_TOKEN: string;
  CODEX_AUTH: string;
  CODEX_API_KEY: string;
}

/** The credential a runtime launches with. Throws when none is set. */
export function credentialFor(env: CredentialEnv, runtime: RuntimeName): { name: string; value: string } {
  return runtimeFor(runtime).credential({
    cursorKey: env.CURSOR_API_KEY,
    anthropicKey: env.ANTHROPIC_API_KEY,
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    codexAuth: env.CODEX_AUTH,
    codexApiKey: env.CODEX_API_KEY,
  });
}

/** Start-up check: every list parses and every runtime in it has a credential. Names the agent that fails. */
export function assertAgents(env: AgentEnv & CredentialEnv): void {
  for (const tier of TIERS) {
    for (const role of ROLES) {
      for (const agent of agentsOf(env, role, tier)) {
        try {
          credentialFor(env, agent.runtime);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new SwarmloopError(`agent ${agent.runtime}:${agent.model} of ${role} has no credential: ${reason}`);
        }
      }
    }
  }
}
