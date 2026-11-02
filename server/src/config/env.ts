import { ConfigService } from '@nestjs/config';
import { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import { RequirementsVia } from '../integrations/requirements-source/requirements-source.registry';

export interface SwarmloopEnv {
  RUNTIME: RuntimeName;
  REQUIREMENTS_VIA: RequirementsVia;
  ISSUE_TRACKER: string;
  JIRA_BASE_URL: string;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
  GITLAB_BASE_URL: string;
  GITLAB_TOKEN: string;
  GITHUB_BASE_URL: string;
  GITHUB_TOKEN: string;
  CURSOR_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  CLAUDE_CODE_OAUTH_TOKEN: string;
  MAX_AGENT_CALLS: number;
  MAX_RETURNS: number;
  MAX_PIPELINE_RETURNS: number;
  MAX_LAUNCHES: number;
  MAX_RUN_USD: number;
  MAX_RUN_TOKENS: number | null;
  STEP_USD_MAX: number | null;
  STEP_TOKEN_MAX: number | null;
  IDLE_TIMEOUT_MS: number;
  TICK_MS: number;
  REQUIREMENTS_TIMEOUT_MS: number;
  RESEARCH_TIMEOUT_MS: number;
  PLAN_TIMEOUT_MS: number;
  IMPLEMENT_TIMEOUT_MS: number;
  CODE_REVIEW_TIMEOUT_MS: number;
  MERGE_REQUEST_TIMEOUT_MS: number;
  PIPELINE_TIMEOUT_MS: number;
  PIPELINE_START_TIMEOUT_MS: number;
  MODEL_RESEARCH: string;
  MODEL_PLAN: string;
  MODEL_IMPLEMENT: string;
  SWARMLOOP_ROOT: string | undefined;
  CHECKOUTS_ROOT: string | undefined;
  SWARMLOOP_API_PORT: number;
  SWARMLOOP_API_HOST: string;
}

/** An empty limit means there is no cap. Zero is a real cap. */
export function optionalLimit(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readEnv(config: ConfigService): SwarmloopEnv {
  const root = config.get<string>('SWARMLOOP_ROOT');
  const checkoutsRoot = config.get<string>('CHECKOUTS_ROOT');
  return {
    RUNTIME: config.getOrThrow<RuntimeName>('RUNTIME'),
    REQUIREMENTS_VIA: config.getOrThrow<RequirementsVia>('REQUIREMENTS_VIA'),
    ISSUE_TRACKER: config.getOrThrow<string>('ISSUE_TRACKER'),
    JIRA_BASE_URL: config.getOrThrow<string>('JIRA_BASE_URL'),
    JIRA_EMAIL: config.getOrThrow<string>('JIRA_EMAIL'),
    JIRA_API_TOKEN: config.getOrThrow<string>('JIRA_API_TOKEN'),
    GITLAB_BASE_URL: config.getOrThrow<string>('GITLAB_BASE_URL'),
    GITLAB_TOKEN: config.getOrThrow<string>('GITLAB_TOKEN'),
    GITHUB_BASE_URL: config.getOrThrow<string>('GITHUB_BASE_URL'),
    GITHUB_TOKEN: config.getOrThrow<string>('GITHUB_TOKEN'),
    CURSOR_API_KEY: config.getOrThrow<string>('CURSOR_API_KEY'),
    ANTHROPIC_API_KEY: config.getOrThrow<string>('ANTHROPIC_API_KEY'),
    CLAUDE_CODE_OAUTH_TOKEN: config.get<string>('CLAUDE_CODE_OAUTH_TOKEN') ?? '',
    MAX_AGENT_CALLS: config.getOrThrow<number>('MAX_AGENT_CALLS'),
    MAX_RETURNS: config.getOrThrow<number>('MAX_RETURNS'),
    MAX_PIPELINE_RETURNS: config.getOrThrow<number>('MAX_PIPELINE_RETURNS'),
    MAX_LAUNCHES: config.getOrThrow<number>('MAX_LAUNCHES'),
    MAX_RUN_USD: config.getOrThrow<number>('MAX_RUN_USD'),
    MAX_RUN_TOKENS: optionalLimit(config.get('MAX_RUN_TOKENS')),
    STEP_USD_MAX: optionalLimit(config.get('STEP_USD_MAX')),
    STEP_TOKEN_MAX: optionalLimit(config.get('STEP_TOKEN_MAX')),
    IDLE_TIMEOUT_MS: config.getOrThrow<number>('IDLE_TIMEOUT_MS'),
    TICK_MS: config.getOrThrow<number>('TICK_MS'),
    REQUIREMENTS_TIMEOUT_MS: config.getOrThrow<number>('REQUIREMENTS_TIMEOUT_MS'),
    RESEARCH_TIMEOUT_MS: config.getOrThrow<number>('RESEARCH_TIMEOUT_MS'),
    PLAN_TIMEOUT_MS: config.getOrThrow<number>('PLAN_TIMEOUT_MS'),
    IMPLEMENT_TIMEOUT_MS: config.getOrThrow<number>('IMPLEMENT_TIMEOUT_MS'),
    CODE_REVIEW_TIMEOUT_MS: config.getOrThrow<number>('CODE_REVIEW_TIMEOUT_MS'),
    MERGE_REQUEST_TIMEOUT_MS: config.getOrThrow<number>('MERGE_REQUEST_TIMEOUT_MS'),
    PIPELINE_TIMEOUT_MS: config.getOrThrow<number>('PIPELINE_TIMEOUT_MS'),
    PIPELINE_START_TIMEOUT_MS: config.getOrThrow<number>('PIPELINE_START_TIMEOUT_MS'),
    MODEL_RESEARCH: config.getOrThrow<string>('MODEL_RESEARCH'),
    MODEL_PLAN: config.getOrThrow<string>('MODEL_PLAN'),
    MODEL_IMPLEMENT: config.getOrThrow<string>('MODEL_IMPLEMENT'),
    SWARMLOOP_ROOT: root ? root : undefined,
    CHECKOUTS_ROOT: checkoutsRoot ? checkoutsRoot : undefined,
    SWARMLOOP_API_PORT: config.getOrThrow<number>('SWARMLOOP_API_PORT'),
    SWARMLOOP_API_HOST: config.getOrThrow<string>('SWARMLOOP_API_HOST'),
  };
}
