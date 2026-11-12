import { BadRequestException, Injectable } from '@nestjs/common';
import { agentsFor, credentialFor, knownModels } from '../config/agents';
import { AppConfig, type SwarmloopEnv } from '../config/env';
import { rawEnv } from '../config/process-env';
import type { SettingsBody, StoredAgents } from '../contract/api';
import { UserSettingRepository } from '../history/user-setting.repository';
import { RUNTIME_NAMES, type RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';

const TIERS = ['main', 'subtask'] as const;
/** The role and the step whose agents are that role's list. */
const ROLE_STEPS = { plan: 'plan', implement: 'implement', review: 'code-review' } as const;
const ROLES = Object.keys(ROLE_STEPS) as (keyof typeof ROLE_STEPS)[];

/** The settings that stay env only, in the order the Server section shows them. */
const SERVER_NAMES = [
  'SWARMLOOP_API_PORT',
  'SWARMLOOP_API_HOST',
  'SWARMLOOP_PUBLIC_URL',
  'SWARMLOOP_ROOT',
  'CHECKOUTS_ROOT',
  'SWARMLOOP_REPOS',
  'SWARMLOOP_ALLOW',
  'MAX_RUN_USD',
  'MAX_RUN_TOKENS',
  'STEP_USD_MAX',
  'STEP_TOKEN_MAX',
  'MAX_AGENT_CALLS',
  'MAX_RETURNS',
  'MAX_PIPELINE_RETURNS',
  'MAX_LAUNCHES',
  'CHECKS_PARALLEL',
  'SUBTASKS_PARALLEL',
  'SPLIT_MAX_TASKS',
  'REQUIREMENTS_TIMEOUT_MS',
  'RESEARCH_TIMEOUT_MS',
  'PLAN_TIMEOUT_MS',
  'IMPLEMENT_TIMEOUT_MS',
  'CODE_REVIEW_TIMEOUT_MS',
  'MERGE_REQUEST_TIMEOUT_MS',
  'PIPELINE_TIMEOUT_MS',
  'PIPELINE_START_TIMEOUT_MS',
  'IDLE_TIMEOUT_MS',
  'STOP_GRACE_S',
  'LIMIT_COOLDOWN_MIN',
  'SANDBOX_EGRESS',
  'SANDBOX_DOCKER_RUNTIME',
  'MIN_FREE_GB',
  'SWARMLOOP_TOKEN',
  'SWARMLOOP_SECRET',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'GITLAB_OAUTH_CLIENT_SECRET',
] as const satisfies readonly (keyof SwarmloopEnv)[];

/** Server settings the sandbox reads straight from the process env; `SwarmloopEnv` does not carry them. */
const PROCESS_ENV_NAMES = ['PROJECT_HOSTS_ALLOW'] as const;

const SECRET = /TOKEN$|SECRET$|API_KEY$/;

export interface ServerSetting {
  name: string;
  secret: boolean;
  /** The env value, or `set` / `not set` for a secret. */
  value: string;
}

/** What `GET /settings` and `PUT /settings` answer. */
export interface SettingsView {
  /** The person's own settings; empty for the machine token and for a person with none. */
  settings: SettingsBody;
  defaults: {
    agents: Record<(typeof TIERS)[number], Record<keyof typeof ROLE_STEPS, string[]>>;
    split: boolean;
  };
  /** The runtimes with a credential, each with the models env names for it. */
  runtimes: { runtime: RuntimeName; models: string[] }[];
  server: ServerSetting[];
}

function refuse(reason: string): never {
  throw new BadRequestException(reason);
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly config: AppConfig,
    private readonly stored: UserSettingRepository,
  ) {}

  async view(actor: string | null): Promise<SettingsView> {
    const env = this.config.env;
    const models = knownModels(env);
    const settings = actor && actor !== 'machine' ? ((await this.stored.read(actor)) ?? {}) : {};
    return {
      settings,
      defaults: { agents: this.defaultAgents(), split: env.SPLIT === 'auto' },
      runtimes: this.connected().map((runtime) => ({ runtime, models: models[runtime] ?? [] })),
      server: [...SERVER_NAMES, ...PROCESS_ENV_NAMES].map((name) => {
        const value = String((name in env ? env[name as keyof SwarmloopEnv] : rawEnv()[name]) ?? '');
        const secret = SECRET.test(name);
        return { name, secret, value: secret ? (value === '' ? 'not set' : 'set') : value };
      }),
    };
  }

  /** Checks the whole body, then replaces the person's settings. A refused body changes nothing. */
  async save(login: string, body: unknown): Promise<SettingsView> {
    const settings = this.validate(body);
    await this.stored.save(login, settings);
    return this.view(login);
  }

  private defaultAgents(): SettingsView['defaults']['agents'] {
    const env = this.config.env;
    const listOf = (parentRunId: number | null) =>
      Object.fromEntries(
        ROLES.map((role) => [
          role,
          agentsFor(env, { parentRunId }, ROLE_STEPS[role]).map((agent) => `${agent.runtime}:${agent.model}`),
        ]),
      ) as Record<keyof typeof ROLE_STEPS, string[]>;
    return { main: listOf(null), subtask: listOf(1) };
  }

  private connected(): RuntimeName[] {
    return RUNTIME_NAMES.filter((runtime) => {
      try {
        credentialFor(this.config.env, runtime);
        return true;
      } catch {
        return false;
      }
    });
  }

  private validate(body: unknown): SettingsBody {
    const given = this.record(body, 'settings');
    this.onlyKeys(given, ['agents', 'split'], 'settings');
    const settings: SettingsBody = {};
    if (given.split !== undefined) {
      if (typeof given.split !== 'boolean') {
        refuse('split must be true or false');
      }
      settings.split = given.split;
    }
    if (given.agents !== undefined) {
      settings.agents = this.validateAgents(given.agents);
    }
    return settings;
  }

  private validateAgents(value: unknown): StoredAgents {
    const tiers = this.record(value, 'agents');
    this.onlyKeys(tiers, TIERS, 'agents');
    const agents: StoredAgents = {};
    for (const tier of TIERS) {
      if (tiers[tier] === undefined) {
        continue;
      }
      const roles = this.record(tiers[tier], `agents.${tier}`);
      this.onlyKeys(roles, ROLES, `agents.${tier}`);
      agents[tier] = Object.fromEntries(
        ROLES.filter((role) => roles[role] !== undefined).map((role) => [role, this.validateList(roles[role], role)]),
      );
    }
    return agents;
  }

  private validateList(list: unknown, role: string): { runtime: string; model: string }[] {
    if (!Array.isArray(list) || list.length === 0) {
      refuse(`the agents of ${role} must be a non-empty list; leave the role out to use the server default`);
    }
    const known = knownModels(this.config.env);
    return list.map((item: unknown) => {
      const entry = this.record(item, `an agent of ${role}`);
      const { runtime, model } = entry;
      const name = RUNTIME_NAMES.find((candidate) => candidate === runtime);
      if (!name || typeof model !== 'string') {
        refuse(`an agent of ${role} needs a known runtime and a model`);
      }
      try {
        credentialFor(this.config.env, name);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        refuse(`agent ${name}:${model} of ${role} has no credential: ${reason}`);
      }
      if (!known[name]?.includes(model)) {
        refuse(`agent ${name}:${model} of ${role} has an unknown model for ${name}`);
      }
      return { runtime: name, model };
    });
  }

  private record(value: unknown, what: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      refuse(`${what} must be an object`);
    }
    return value as Record<string, unknown>;
  }

  private onlyKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
    const extra = Object.keys(value).find((key) => !allowed.includes(key));
    if (extra !== undefined) {
      refuse(`${what} has an unknown key "${extra}"`);
    }
  }
}
