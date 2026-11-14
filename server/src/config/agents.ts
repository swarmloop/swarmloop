import type { StoredAgents } from '../contract/api';
import type { CODE_REVIEWERS, StepName } from '../contract/steps';
import type { Effort } from '../contract/effort';
import { EFFORTS, highestOf, isEffort } from '../contract/effort';
import { SwarmloopError } from '../core/swarmloop-error';
import { RUNTIME_NAMES, runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';

/**
 * An agent is a runtime, the model it runs and how hard it works. It is written `runtime:model[:effort]`.
 * `effortNote` says why a resolved effort is not the agent's own: `epic` or `capped:<wanted>`.
 */
export interface Agent {
  runtime: RuntimeName;
  model: string;
  effort?: Effort;
  effortNote?: string;
}

const ROLES = ['plan', 'implement', 'review'] as const;
type Role = (typeof ROLES)[number];

/** A run with a parent is a subtask and has its own agents. */
const TIERS = ['main', 'subtask'] as const;
type Tier = (typeof TIERS)[number];

/** The env values that name agents: the role lists. */
interface AgentEnv {
  AGENTS_PLAN: string;
  AGENTS_IMPLEMENT: string;
  AGENTS_REVIEW: string;
  AGENTS_SUBTASK_PLAN: string;
  AGENTS_SUBTASK_IMPLEMENT: string;
  AGENTS_SUBTASK_REVIEW: string;
  EPIC_EFFORT: string;
}

/** What `agentFor` reads of a run: only a run with a parent is a subtask. */
type AgentRun = object & {
  parentRunId?: number | null;
  epicAt?: string | null;
  agents?: StoredAgents | null;
};

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

/**
 * One agent, `runtime:model[:effort]`. The runtime is everything before the first colon. A trailing `:<word>` is the
 * effort only when the word is one of the five levels, so `cursor:grok-4.7-high` keeps its model id. `name` is the
 * env name or the role, and it is in every error.
 */
export function parseAgent(name: string, entry: string): Agent {
  const agent = splitAgent(name, entry);
  const { runtime, model, effort } = agent;
  if (effort) {
    assertListLoaded(name, agent);
  }
  if (effort && !runtimeFor(runtime).efforts(model).includes(effort)) {
    throw new SwarmloopError(
      `${name} has agent "${runtime}:${model}:${effort}" and ${runtime} does not support effort ${effort} for ${model}`,
    );
  }
  return agent;
}

/** An agent that names a level needs its runtime's model list. Without it the level is neither accepted nor dropped. */
function assertListLoaded(name: string, { runtime, model, effort }: Agent): void {
  if (!runtimeFor(runtime).listLoaded()) {
    throw new SwarmloopError(
      `${name} has agent "${runtime}:${model}:${effort}", but the model list of ${runtime} is not loaded: ` +
        `check the ${runtime} key and that docker runs, then start swarmloop again so the list is read`,
    );
  }
}

/** The parts of an entry, without asking the runtime whether it supports the level. */
export function splitAgent(name: string, entry: string): Agent {
  const text = entry.trim();
  const colon = text.indexOf(':');
  const runtime = colon < 0 ? text : text.slice(0, colon).trim();
  const rest = colon < 0 ? '' : text.slice(colon + 1).trim();
  const known = RUNTIME_NAMES.find((candidate) => candidate === runtime);
  if (!known) {
    throw new SwarmloopError(`${name} has unknown runtime "${runtime}" in agent "${text}"`);
  }
  const last = rest.lastIndexOf(':');
  const tail = last < 0 ? '' : rest.slice(last + 1).trim();
  const effort = isEffort(tail) ? tail : undefined;
  const model = effort ? rest.slice(0, last).trim() : rest;
  if (model === '') {
    throw new SwarmloopError(`${name} has an empty model in agent "${text}"`);
  }
  return effort ? { runtime: known, model, effort } : { runtime: known, model };
}

/** An ordered, comma-separated list of `runtime:model[:effort]`. The first agent runs; the rest are the fallback order. */
export function parseAgentList(name: string, text: string): Agent[] {
  return text.split(',').map((item) => parseAgent(name, item));
}

const LISTS: Record<Tier, Record<Role, keyof AgentEnv>> = {
  main: { plan: 'AGENTS_PLAN', implement: 'AGENTS_IMPLEMENT', review: 'AGENTS_REVIEW' },
  subtask: { plan: 'AGENTS_SUBTASK_PLAN', implement: 'AGENTS_SUBTASK_IMPLEMENT', review: 'AGENTS_SUBTASK_REVIEW' },
};

/**
 * The run's stored choice for one role and tier. An entry whose runtime is unknown is dropped. A stored level that
 * its runtime no longer declares is dropped too: it was checked when saved, and a changed model list must not stop a
 * running run.
 */
function storedAgents(run: AgentRun | null | undefined, role: Role, tier: Tier): Agent[] {
  const agents: Agent[] = [];
  for (const { runtime, model, effort } of run?.agents?.[tier]?.[role] ?? []) {
    const known = RUNTIME_NAMES.find((candidate) => candidate === runtime);
    if (!known) {
      continue;
    }
    if (effort) {
      assertListLoaded(role, { runtime: known, model, effort: effort as Effort });
    }
    try {
      agents.push(effort ? parseAgent(role, `${known}:${model}:${effort}`) : { runtime: known, model });
    } catch {
      agents.push({ runtime: known, model });
    }
  }
  return agents;
}

/**
 * The level an agent runs at: its own, raised to `EPIC_EFFORT` for the parent of a split run (never lowered), then
 * held to the highest level its runtime declares for the model.
 */
function resolveEffort(agent: Agent, run: AgentRun | null | undefined, env: AgentEnv): Agent {
  const { effort: own, ...base } = agent;
  let wanted = own;
  let note: string | undefined;
  const epic = env.EPIC_EFFORT;
  if (
    isEffort(epic) &&
    run &&
    !run.parentRunId &&
    run.epicAt &&
    (!own || EFFORTS.indexOf(epic) > EFFORTS.indexOf(own))
  ) {
    wanted = epic;
    note = 'epic';
  }
  const levels = runtimeFor(agent.runtime).efforts(agent.model);
  if (!wanted || levels.length === 0) {
    return base;
  }
  const level = highestOf(levels, wanted);
  if (level !== wanted) {
    note = `capped:${wanted}`;
  }
  return { ...base, ...(level ? { effort: level } : {}), ...(note ? { effortNote: note } : {}) };
}

/**
 * The agents of one role in one tier, in fallback order. The run's stored choice comes first; else an unset list
 * falls back to the main role, whose list is required.
 */
function agentsOf(env: AgentEnv, role: Role, tier: Tier = 'main', run?: AgentRun | null): Agent[] {
  const stored = storedAgents(run, role, tier);
  if (stored.length > 0) {
    return stored.map((agent) => resolveEffort(agent, run, env));
  }
  const own = LISTS[tier][role];
  const name = env[own] === '' ? LISTS.main[role] : own;
  return parseAgentList(name, env[name]).map((agent) => resolveEffort(agent, run, env));
}

/** The agent a step runs on, or null when the step has none. The only place that maps a step to a role and an agent. */
export function agentFor(env: AgentEnv, run: AgentRun | null, step: AgentUseName): Agent;
export function agentFor(env: AgentEnv, run: AgentRun | null, step: string): Agent | null;
export function agentFor(env: AgentEnv, run: AgentRun | null, step: string): Agent | null {
  const role = roleFor(step);
  return role ? agentsOf(env, role, tierOf(run), run)[0] : null;
}

/** Every agent of a step's role and tier, in fallback order. Empty for a step without an agent. */
export function agentsFor(env: AgentEnv, run: AgentRun | null, step: string): Agent[] {
  const role = roleFor(step);
  return role ? agentsOf(env, role, tierOf(run), run) : [];
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

/** Every distinct runtime named in any role of any tier of the server defaults (env). */
export function runtimesInUse(env: AgentEnv): RuntimeName[] {
  const all = TIERS.flatMap((tier) => ROLES.flatMap((role) => agentsOf(env, role, tier)));
  return [...new Set(all.map((agent) => agent.runtime))];
}

/** The runtimes whose env agents name an effort. Their model lists must be read before the levels can be checked. */
export function runtimesNamingEffort(env: AgentEnv): RuntimeName[] {
  const names = TIERS.flatMap((tier) => ROLES.map((role) => LISTS[tier][role])).filter((name) => env[name] !== '');
  const agents = names.flatMap((name) => env[name].split(',').map((item) => splitAgent(name, item)));
  return [...new Set(agents.filter((agent) => agent.effort).map((agent) => agent.runtime))];
}

/** The models env names for each runtime, once each, in env order: the role lists. */
export function knownModels(env: AgentEnv): Partial<Record<RuntimeName, string[]>> {
  const models: Partial<Record<RuntimeName, string[]>> = {};
  for (const { runtime, model } of TIERS.flatMap((tier) => ROLES.flatMap((role) => agentsOf(env, role, tier)))) {
    const list = (models[runtime] ??= []);
    if (!list.includes(model)) {
      list.push(model);
    }
  }
  return models;
}

/** Every agent of every role and tier of a run, in role order: the run's stored choice first, else env. */
export function runAgents(env: AgentEnv, run: AgentRun | null): Agent[] {
  return TIERS.flatMap((tier) => ROLES.flatMap((role) => agentsOf(env, role, tier, run)));
}

/** What a person hears when a runtime of their run has no credential for them. */
export function missingCredential(runtime: RuntimeName): string {
  return `${runtime} has no credential for you: connect it in Connections (/connections#${runtime})`;
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
