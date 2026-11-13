import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import type { RequirementsVia } from '../integrations/requirements-source/requirements-source.registry';

export interface SwarmloopEnv {
  RUNTIME: RuntimeName;
  REQUIREMENTS_VIA: RequirementsVia;
  ISSUE_TRACKER: string;
  JIRA_BASE_URL: string;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
  JIRA_PROJECTS: string;
  GITLAB_BASE_URL: string;
  GITLAB_TOKEN: string;
  GITHUB_BASE_URL: string;
  GITHUB_TOKEN: string;
  CURSOR_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  CLAUDE_CODE_OAUTH_TOKEN: string;
  CODEX_AUTH: string;
  CODEX_API_KEY: string;
  MAX_AGENT_CALLS: number;
  MAX_RETURNS: number;
  MAX_PIPELINE_RETURNS: number;
  MAX_LAUNCHES: number;
  CHECKS_PARALLEL: number;
  RESERVE_CPUS: number;
  RESERVE_MEMORY_GB: number;
  LIMIT_COOLDOWN_MIN: number;
  STOP_GRACE_S: number;
  RECONCILE_MS: number;
  MERGE_WATCH_MIN: number;
  RECOVER_WAIT_MS: number;
  RETAIN_DONE_DAYS: number;
  MIN_FREE_GB: number;
  DOCKER_PRUNE: boolean;
  MAX_RUN_USD: number;
  MAX_RUN_TOKENS: number | null;
  STEP_USD_MAX: number | null;
  STEP_TOKEN_MAX: number | null;
  IDLE_TIMEOUT_MS: number;
  LOOP_REPEAT: number;
  SANDBOX_EGRESS: 'proxy' | 'open';
  SANDBOX_DOCKER_RUNTIME: string;
  TICK_MS: number;
  REQUIREMENTS_TIMEOUT_MS: number;
  RESEARCH_TIMEOUT_MS: number;
  PLAN_TIMEOUT_MS: number;
  IMPLEMENT_TIMEOUT_MS: number;
  CODE_REVIEW_TIMEOUT_MS: number;
  MERGE_REQUEST_TIMEOUT_MS: number;
  PIPELINE_TIMEOUT_MS: number;
  PIPELINE_START_TIMEOUT_MS: number;
  MODEL_PLAN: string;
  MODEL_IMPLEMENT: string;
  AGENTS_PLAN: string;
  AGENTS_IMPLEMENT: string;
  AGENTS_REVIEW: string;
  AGENTS_SUBTASK_PLAN: string;
  AGENTS_SUBTASK_IMPLEMENT: string;
  AGENTS_SUBTASK_REVIEW: string;
  SPLIT: 'auto' | 'off';
  SPLIT_MAX_TASKS: number;
  SUBTASKS_PARALLEL: number;
  SWARMLOOP_ROOT: string | undefined;
  CHECKOUTS_ROOT: string | undefined;
  SWARMLOOP_API_PORT: number;
  SWARMLOOP_API_HOST: string;
  SWARMLOOP_PUBLIC_URL: string;
  SWARMLOOP_REPOS: string[];
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  GITLAB_OAUTH_CLIENT_ID: string;
  GITLAB_OAUTH_CLIENT_SECRET: string;
  SWARMLOOP_ALLOW: string;
  SWARMLOOP_TOKEN: string;
  SWARMLOOP_SECRET: string;
}

/** An empty limit means there is no cap. Zero is a real cap. */
export function optionalLimit(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A setting that may be absent: an empty string then. */
function optionalText(config: ConfigService, name: string): string {
  return config.get<string>(name) ?? '';
}

export function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** The validated env, read once at startup and injected wherever services need config. */
export class AppConfig {
  constructor(readonly env: SwarmloopEnv) {}
}

export function readEnv(config: ConfigService): SwarmloopEnv {
  if (config.get('MODEL_RESEARCH') !== undefined) {
    new Logger('Config').warn('MODEL_RESEARCH is set but was never read: research runs on MODEL_PLAN or AGENTS_PLAN');
  }
  const root = config.get<string>('SWARMLOOP_ROOT');
  const checkoutsRoot = config.get<string>('CHECKOUTS_ROOT');
  return {
    RUNTIME: config.getOrThrow<RuntimeName>('RUNTIME'),
    REQUIREMENTS_VIA: config.getOrThrow<RequirementsVia>('REQUIREMENTS_VIA'),
    ISSUE_TRACKER: config.getOrThrow<string>('ISSUE_TRACKER'),
    JIRA_BASE_URL: config.getOrThrow<string>('JIRA_BASE_URL'),
    JIRA_EMAIL: config.getOrThrow<string>('JIRA_EMAIL'),
    JIRA_API_TOKEN: config.getOrThrow<string>('JIRA_API_TOKEN'),
    JIRA_PROJECTS: config.get<string>('JIRA_PROJECTS') ?? '',
    GITLAB_BASE_URL: config.getOrThrow<string>('GITLAB_BASE_URL'),
    GITLAB_TOKEN: config.getOrThrow<string>('GITLAB_TOKEN'),
    GITHUB_BASE_URL: config.getOrThrow<string>('GITHUB_BASE_URL'),
    GITHUB_TOKEN: config.getOrThrow<string>('GITHUB_TOKEN'),
    CURSOR_API_KEY: config.getOrThrow<string>('CURSOR_API_KEY'),
    ANTHROPIC_API_KEY: config.getOrThrow<string>('ANTHROPIC_API_KEY'),
    CLAUDE_CODE_OAUTH_TOKEN: config.get<string>('CLAUDE_CODE_OAUTH_TOKEN') ?? '',
    CODEX_AUTH: config.get<string>('CODEX_AUTH') ?? '',
    CODEX_API_KEY: config.get<string>('CODEX_API_KEY') ?? '',
    MAX_AGENT_CALLS: config.getOrThrow<number>('MAX_AGENT_CALLS'),
    MAX_RETURNS: config.getOrThrow<number>('MAX_RETURNS'),
    MAX_PIPELINE_RETURNS: config.getOrThrow<number>('MAX_PIPELINE_RETURNS'),
    MAX_LAUNCHES: config.getOrThrow<number>('MAX_LAUNCHES'),
    CHECKS_PARALLEL: config.getOrThrow<number>('CHECKS_PARALLEL'),
    RESERVE_CPUS: config.getOrThrow<number>('RESERVE_CPUS'),
    RESERVE_MEMORY_GB: config.getOrThrow<number>('RESERVE_MEMORY_GB'),
    LIMIT_COOLDOWN_MIN: config.getOrThrow<number>('LIMIT_COOLDOWN_MIN'),
    STOP_GRACE_S: config.getOrThrow<number>('STOP_GRACE_S'),
    RECONCILE_MS: config.getOrThrow<number>('RECONCILE_MS'),
    MERGE_WATCH_MIN: config.getOrThrow<number>('MERGE_WATCH_MIN'),
    RECOVER_WAIT_MS: config.getOrThrow<number>('RECOVER_WAIT_MS'),
    RETAIN_DONE_DAYS: config.getOrThrow<number>('RETAIN_DONE_DAYS'),
    MIN_FREE_GB: config.getOrThrow<number>('MIN_FREE_GB'),
    DOCKER_PRUNE: config.getOrThrow<boolean>('DOCKER_PRUNE'),
    MAX_RUN_USD: config.getOrThrow<number>('MAX_RUN_USD'),
    MAX_RUN_TOKENS: optionalLimit(config.get('MAX_RUN_TOKENS')),
    STEP_USD_MAX: optionalLimit(config.get('STEP_USD_MAX')),
    STEP_TOKEN_MAX: optionalLimit(config.get('STEP_TOKEN_MAX')),
    IDLE_TIMEOUT_MS: config.getOrThrow<number>('IDLE_TIMEOUT_MS'),
    LOOP_REPEAT: config.getOrThrow<number>('LOOP_REPEAT'),
    SANDBOX_EGRESS: config.get<string>('SANDBOX_EGRESS') === 'open' ? 'open' : 'proxy',
    SANDBOX_DOCKER_RUNTIME: config.get<string>('SANDBOX_DOCKER_RUNTIME') ?? '',
    TICK_MS: config.getOrThrow<number>('TICK_MS'),
    REQUIREMENTS_TIMEOUT_MS: config.getOrThrow<number>('REQUIREMENTS_TIMEOUT_MS'),
    RESEARCH_TIMEOUT_MS: config.getOrThrow<number>('RESEARCH_TIMEOUT_MS'),
    PLAN_TIMEOUT_MS: config.getOrThrow<number>('PLAN_TIMEOUT_MS'),
    IMPLEMENT_TIMEOUT_MS: config.getOrThrow<number>('IMPLEMENT_TIMEOUT_MS'),
    CODE_REVIEW_TIMEOUT_MS: config.getOrThrow<number>('CODE_REVIEW_TIMEOUT_MS'),
    MERGE_REQUEST_TIMEOUT_MS: config.getOrThrow<number>('MERGE_REQUEST_TIMEOUT_MS'),
    PIPELINE_TIMEOUT_MS: config.getOrThrow<number>('PIPELINE_TIMEOUT_MS'),
    PIPELINE_START_TIMEOUT_MS: config.getOrThrow<number>('PIPELINE_START_TIMEOUT_MS'),
    MODEL_PLAN: config.getOrThrow<string>('MODEL_PLAN'),
    MODEL_IMPLEMENT: config.getOrThrow<string>('MODEL_IMPLEMENT'),
    AGENTS_PLAN: config.get<string>('AGENTS_PLAN') ?? '',
    AGENTS_IMPLEMENT: config.get<string>('AGENTS_IMPLEMENT') ?? '',
    AGENTS_REVIEW: config.get<string>('AGENTS_REVIEW') ?? '',
    AGENTS_SUBTASK_PLAN: config.get<string>('AGENTS_SUBTASK_PLAN') ?? '',
    AGENTS_SUBTASK_IMPLEMENT: config.get<string>('AGENTS_SUBTASK_IMPLEMENT') ?? '',
    AGENTS_SUBTASK_REVIEW: config.get<string>('AGENTS_SUBTASK_REVIEW') ?? '',
    SPLIT: config.get<'auto' | 'off'>('SPLIT') ?? 'off',
    SPLIT_MAX_TASKS: config.get<number>('SPLIT_MAX_TASKS') ?? 48,
    SUBTASKS_PARALLEL: config.get<number>('SUBTASKS_PARALLEL') ?? 3,
    SWARMLOOP_ROOT: root ? root : undefined,
    CHECKOUTS_ROOT: checkoutsRoot ? checkoutsRoot : undefined,
    SWARMLOOP_API_PORT: config.getOrThrow<number>('SWARMLOOP_API_PORT'),
    SWARMLOOP_API_HOST: config.getOrThrow<string>('SWARMLOOP_API_HOST'),
    SWARMLOOP_PUBLIC_URL: config.getOrThrow<string>('SWARMLOOP_PUBLIC_URL'),
    SWARMLOOP_REPOS: splitList(config.get<string>('SWARMLOOP_REPOS')),
    GITHUB_OAUTH_CLIENT_ID: optionalText(config, 'GITHUB_OAUTH_CLIENT_ID'),
    GITHUB_OAUTH_CLIENT_SECRET: optionalText(config, 'GITHUB_OAUTH_CLIENT_SECRET'),
    GITLAB_OAUTH_CLIENT_ID: optionalText(config, 'GITLAB_OAUTH_CLIENT_ID'),
    GITLAB_OAUTH_CLIENT_SECRET: optionalText(config, 'GITLAB_OAUTH_CLIENT_SECRET'),
    SWARMLOOP_ALLOW: optionalText(config, 'SWARMLOOP_ALLOW'),
    SWARMLOOP_TOKEN: optionalText(config, 'SWARMLOOP_TOKEN'),
    SWARMLOOP_SECRET: optionalText(config, 'SWARMLOOP_SECRET'),
  };
}
