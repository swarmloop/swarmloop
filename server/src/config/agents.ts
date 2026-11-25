import type { StoredAgents } from '../contract/api';
import type { CODE_REVIEWERS, StepName } from '../contract/steps';
import type { Effort } from '../contract/effort';
import { highestOf, isEffort, raisesEffort } from '../contract/effort';
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

/** The backlog's planner has a list of its own, for the plan role only. No run reads it. */
type ListTier = Tier | 'backlog';

/** The env values that name agents: the role lists. */
interface AgentEnv {
  AGENTS_PLAN: string;
  AGENTS_IMPLEMENT: string;
  AGENTS_REVIEW: string;
  AGENTS_SUBTASK_PLAN: string;
  AGENTS_SUBTASK_IMPLEMENT: string;
  AGENTS_SUBTASK_REVIEW: string;
  AGENTS_BACKLOG_PLAN: string;
  AGENTS_BACKLOG_READ: string;
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
  StepName | 'code-review-report' | `code-review-${(typeof CODE_REVIEWERS)[number]}` | 'rebase' | 'backlog-plan';

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
  rebase: 'implement',
  'backlog-plan': 'plan',
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
function splitAgent(name: string, entry: string): Agent {
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

/** The run's stored entries for one role and tier, as written. An entry whose runtime is unknown is dropped. */
function knownStored(
  run: AgentRun | null | undefined,
  role: Role,
  tier: ListTier,
): { runtime: RuntimeName; model: string; effort?: string }[] {
  return (run?.agents?.[tier]?.[role] ?? []).flatMap(({ runtime, model, effort }) => {
    const known = RUNTIME_NAMES.find((candidate) => candidate === runtime);
    return known ? [{ runtime: known, model, effort }] : [];
  });
}

/**
 * The run's stored choice for one role and tier. A stored level that its runtime no longer declares is dropped: it
 * was checked when saved, and a changed model list must not stop a running run.
 */
function storedAgents(run: AgentRun | null | undefined, role: Role, tier: ListTier): Agent[] {
  const agents: Agent[] = [];
  for (const { runtime: known, model, effort } of knownStored(run, role, tier)) {
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
 * The level an agent runs at: its own, raised to `EPIC_EFFORT` only for the plan role of the parent of a split run
 * (never lowered), then held to the highest level its runtime declares for the model.
 */
function resolveEffort(agent: Agent, run: AgentRun | null | undefined, env: AgentEnv, role: Role): Agent {
  const { effort: own, ...base } = agent;
  let wanted = own;
  let note: string | undefined;
  const epic = env.EPIC_EFFORT;
  if (isEffort(epic) && role === 'plan' && run && !run.parentRunId && run.epicAt && raisesEffort(epic, own)) {
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

/** The env name of the list a role and tier read: an unset subtask or backlog list falls back to the main role. */
function listName(env: AgentEnv, role: Role, tier: ListTier): keyof AgentEnv {
  const own = tier === 'backlog' ? 'AGENTS_BACKLOG_PLAN' : LISTS[tier][role];
  return env[own] === '' ? LISTS.main[role] : own;
}

/**
 * The agents of one role in one tier, in fallback order. The run's stored choice comes first; else an unset list
 * falls back to the main role, whose list is required.
 */
function agentsOf(env: AgentEnv, role: Role, tier: ListTier = 'main', run?: AgentRun | null): Agent[] {
  const stored = storedAgents(run, role, tier);
  if (stored.length > 0) {
    return stored.map((agent) => resolveEffort(agent, run, env, role));
  }
  const name = listName(env, role, tier);
  return parseAgentList(name, env[name]).map((agent) => resolveEffort(agent, run, env, role));
}

/**
 * The agents of one role and tier as written: the run's stored choice, else the env list. A level is read but not
 * checked, so no model list is needed. It serves what only shows or counts agents; a launch uses `agentsOf`.
 */
function namedAgents(env: AgentEnv, role: Role, tier: ListTier, run?: AgentRun | null): Agent[] {
  const stored = knownStored(run, role, tier).map(({ runtime, model, effort }) =>
    effort && isEffort(effort) ? { runtime, model, effort } : { runtime, model },
  );
  if (stored.length > 0) {
    return stored;
  }
  const name = listName(env, role, tier);
  return env[name].split(',').map((item) => splitAgent(name, item));
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

/** The first agent of a list whose runtime is not cooling down, or null when every one is. */
export function firstAvailable(agents: readonly Agent[], cooling: ReadonlySet<string>): Agent | null {
  return agents.find((agent) => !cooling.has(agent.runtime)) ?? null;
}

function tierOf(run: AgentRun | null): Tier {
  return run?.parentRunId ? 'subtask' : 'main';
}

/** The role and tier of a step, for the line the step window shows. */
export function roleOf(run: AgentRun | null, step: string): { role: Role; tier: Tier } | null {
  const role = roleFor(step);
  return role ? { role, tier: tierOf(run) } : null;
}

/** The agents the server defaults (env) name for a step's role and tier, as written. Empty for a step without an agent. */
export function namedAgentsFor(env: AgentEnv, run: AgentRun | null, step: string): Agent[] {
  const role = roleFor(step);
  return role ? namedAgents(env, role, tierOf(run), run) : [];
}

/**
 * The agents of the backlog's planner: a person's stored choice first, else the env list (an empty one is the main
 * plan role), with the effort resolved and capped and the fallback order kept.
 */
export function backlogPlanAgents(env: AgentEnv, stored?: StoredAgents | null): Agent[] {
  return agentsOf(env, 'plan', 'backlog', { agents: stored });
}

/**
 * The helpers a backlog planner turn hands reading to, read only. An empty list is no helper and never falls back to
 * another list. A level is resolved and capped as for every list.
 */
export function backlogReadAgents(env: AgentEnv): Agent[] {
  if (env.AGENTS_BACKLOG_READ === '') {
    return [];
  }
  return parseAgentList('AGENTS_BACKLOG_READ', env.AGENTS_BACKLOG_READ).map((agent) =>
    resolveEffort(agent, null, env, 'plan'),
  );
}

/** The first helper of the runtime that runs, or none when the list has none or the runtime has no helpers. */
export function helperFor(helpers: readonly Agent[] | undefined, runtime: RuntimeName): Agent | undefined {
  return runtimeFor(runtime).hasHelpers ? helpers?.find((agent) => agent.runtime === runtime) : undefined;
}

/** The backlog planner's agents the server defaults (env) name, as written. */
export function namedBacklogPlanAgents(env: AgentEnv): Agent[] {
  return namedAgents(env, 'plan', 'backlog');
}

/** Every agent the server defaults (env) name, in every role of every tier and the backlog's plan list. */
function namedEverywhere(env: AgentEnv): Agent[] {
  return [
    ...TIERS.flatMap((tier) => ROLES.flatMap((role) => namedAgents(env, role, tier))),
    ...namedBacklogPlanAgents(env),
  ];
}

/** Every distinct runtime named in any role of any tier of the server defaults (env). */
export function runtimesInUse(env: AgentEnv): RuntimeName[] {
  const all = namedEverywhere(env);
  return [...new Set(all.map((agent) => agent.runtime))];
}

/** The runtimes whose env agents name an effort. Their model lists must be read before the levels can be checked. */
export function runtimesNamingEffort(env: AgentEnv): RuntimeName[] {
  const names = [
    ...TIERS.flatMap((tier) => ROLES.map((role) => LISTS[tier][role])),
    'AGENTS_BACKLOG_PLAN' as const,
    'AGENTS_BACKLOG_READ' as const,
  ].filter((name) => env[name] !== '');
  const agents = names.flatMap((name) => env[name].split(',').map((item) => splitAgent(name, item)));
  return [...new Set(agents.filter((agent) => agent.effort).map((agent) => agent.runtime))];
}

/** The models env names for each runtime, once each, in env order: the role lists. */
export function knownModels(env: AgentEnv): Partial<Record<RuntimeName, string[]>> {
  const models: Partial<Record<RuntimeName, string[]>> = {};
  for (const { runtime, model } of namedEverywhere(env)) {
    const list = (models[runtime] ??= []);
    if (!list.includes(model)) {
      list.push(model);
    }
  }
  return models;
}

/**
 * Every agent of every role and tier of a run, as written, in role order: the run's stored choice first, else env.
 * It tells which runtimes a run can use, so it needs no model list.
 */
export function runAgents(env: AgentEnv, run: AgentRun | null): Agent[] {
  return TIERS.flatMap((tier) => ROLES.flatMap((role) => namedAgents(env, role, tier, run)));
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

type RuntimeKeys = Parameters<ReturnType<typeof runtimeFor>['credential']>[0];

/** The keys of every runtime, read from env names. A name that is absent counts as empty. */
export function runtimeKeysOf(env: Partial<CredentialEnv>): RuntimeKeys {
  return {
    cursorKey: env.CURSOR_API_KEY ?? '',
    anthropicKey: env.ANTHROPIC_API_KEY ?? '',
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
    codexAuth: env.CODEX_AUTH ?? '',
    codexApiKey: env.CODEX_API_KEY ?? '',
  };
}

/**
 * The credential a runtime launches with, read from env names: the server's env, or the fields a person stored for a
 * connection, which use the same names. A name that is absent counts as empty. Throws when none is set.
 */
export function credentialFor(env: Partial<CredentialEnv>, runtime: RuntimeName): { name: string; value: string } {
  return runtimeFor(runtime).credential(runtimeKeysOf(env));
}

/**
 * Start-up check: every list parses. A missing credential is a readiness item, not a refusal to start. The level of
 * an agent is checked only when its runtime's model list is loaded: without a key the list cannot be read.
 */
export function assertAgents(env: AgentEnv): void {
  const lists: [Role, ListTier][] = TIERS.flatMap((tier) => ROLES.map((role): [Role, ListTier] => [role, tier]));
  for (const [role, tier] of [...lists, ['plan', 'backlog'] as [Role, ListTier]]) {
    assertList(listName(env, role, tier), env);
  }
  if (env.AGENTS_BACKLOG_READ !== '') {
    assertList('AGENTS_BACKLOG_READ', env);
  }
}

function assertList(name: keyof AgentEnv, env: AgentEnv): void {
  for (const entry of env[name].split(',')) {
    const { runtime, effort } = splitAgent(name, entry);
    if (!effort || runtimeFor(runtime).listLoaded()) {
      parseAgent(name, entry);
    }
  }
}
