import { BadRequestException, Injectable } from '@nestjs/common';
import { loadPriceTable } from '../agent/prices';
import { agentsFor, credentialFor, knownModels } from '../config/agents';
import { AppConfig, type SwarmloopEnv } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { rawEnv } from '../config/process-env';
import { Clock } from '../core/clock';
import type { SettingsBody, StoredAgents } from '../contract/api';
import type { SettingsView } from '../contract/settings';
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

function refuse(reason: string): never {
  throw new BadRequestException(reason);
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly config: AppConfig,
    private readonly stored: UserSettingRepository,
    private readonly clock: Clock,
  ) {}

  async view(actor: string | null): Promise<SettingsView> {
    const env = this.config.env;
    const { runtimes, limited } = await this.models();
    const settings = actor && actor !== 'machine' ? ((await this.stored.read(actor)) ?? {}) : {};
    return {
      settings,
      defaults: { agents: this.defaultAgents() },
      runtimes,
      modelsLimited: limited,
      server: [...SERVER_NAMES, ...PROCESS_ENV_NAMES].map((name) => {
        const value = String((name in env ? env[name as keyof SwarmloopEnv] : rawEnv()[name]) ?? '');
        const secret = SECRET.test(name);
        return { name, secret, value: secret ? (value === '' ? 'not set' : 'set') : value };
      }),
    };
  }

  /** Checks the whole body, then replaces the person's settings. A refused body changes nothing. */
  async save(login: string, body: unknown): Promise<SettingsView> {
    const settings = await this.validate(body);
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

  /** Per connected runtime: the models env names, then its priced models. Limited when a table could not be read. */
  private async models(): Promise<{ runtimes: SettingsView['runtimes']; limited: boolean }> {
    const env = this.config.env;
    const named = knownModels(env);
    const root = resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname);
    let limited = false;
    const runtimes = await Promise.all(
      this.connected().map(async (runtime) => {
        const priced = Object.keys(await loadPriceTable(root, runtime, this.clock.now()));
        limited ||= priced.length === 0;
        return { runtime, models: [...new Set([...(named[runtime] ?? []), ...priced])] };
      }),
    );
    return { runtimes, limited };
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

  private async validate(body: unknown): Promise<SettingsBody> {
    const given = this.record(body, 'settings');
    this.onlyKeys(given, ['agents'], 'settings');
    const settings: SettingsBody = {};
    if (given.agents !== undefined) {
      settings.agents = await this.validateAgents(given.agents);
    }
    return settings;
  }

  private async validateAgents(value: unknown): Promise<StoredAgents> {
    const tiers = this.record(value, 'agents');
    this.onlyKeys(tiers, TIERS, 'agents');
    const agents: StoredAgents = {};
    const { runtimes } = await this.models();
    for (const tier of TIERS) {
      if (tiers[tier] === undefined) {
        continue;
      }
      const roles = this.record(tiers[tier], `agents.${tier}`);
      this.onlyKeys(roles, ROLES, `agents.${tier}`);
      agents[tier] = Object.fromEntries(
        ROLES.filter((role) => roles[role] !== undefined).map((role) => [
          role,
          this.validateList(roles[role], role, runtimes),
        ]),
      );
    }
    return agents;
  }

  private validateList(
    list: unknown,
    role: string,
    runtimes: SettingsView['runtimes'],
  ): { runtime: string; model: string }[] {
    if (!Array.isArray(list) || list.length === 0) {
      refuse(`the agents of ${role} must be a non-empty list; leave the role out to use the server default`);
    }
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
      if (!runtimes.find((offered) => offered.runtime === name)?.models.includes(model)) {
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
