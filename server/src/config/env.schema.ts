import Joi from 'joi';
import { parseAllow } from '../auth/allow-list';
import { EFFORTS } from '../contract/effort';
import { IssueTrackerRegistry } from '../integrations/issue-tracker/issue-tracker.registry';
import { names } from '../integrations/requirements-source/requirements-source.registry';

const MAIN_AGENTS_MISSING = '{{#key}} is missing: set it as in defaults.env';

/** Missing lists come from defaults.env; explicitly empty lists are invalid. */
function mainAgents(): Joi.StringSchema {
  return Joi.string().messages({ 'string.empty': MAIN_AGENTS_MISSING });
}

export const envSchema = Joi.object({
  REQUIREMENTS_VIA: Joi.string().valid(...names),
  ISSUE_TRACKER: Joi.string().valid(...IssueTrackerRegistry.names),
  JIRA_BASE_URL: Joi.string().allow(''),
  JIRA_EMAIL: Joi.string().allow(''),
  JIRA_API_TOKEN: Joi.string().allow(''),
  JIRA_PROJECTS: Joi.string().allow(''),
  GITLAB_BASE_URL: Joi.string().allow(''),
  GITLAB_TOKEN: Joi.string().allow(''),
  GITHUB_BASE_URL: Joi.string().allow(''),
  GITHUB_TOKEN: Joi.string().allow(''),
  CURSOR_API_KEY: Joi.string().allow(''),
  ANTHROPIC_API_KEY: Joi.string().allow(''),
  CLAUDE_CODE_OAUTH_TOKEN: Joi.string().allow(''),
  CODEX_AUTH: Joi.string().allow(''),
  CODEX_API_KEY: Joi.string().allow(''),
  MAX_AGENT_CALLS: Joi.number(),
  MAX_RETURNS: Joi.number().integer().min(1),
  MAX_PIPELINE_RETURNS: Joi.number().integer().min(1),
  MAX_LAUNCHES: Joi.number().integer().min(1),
  CHECKS_PARALLEL: Joi.number().integer().min(1),
  RESERVE_MEMORY_GB: Joi.number().min(0),
  LIMIT_COOLDOWN_MIN: Joi.number().integer().min(1),
  STOP_GRACE_S: Joi.number().integer().min(1),
  RECONCILE_MS: Joi.number().integer().min(1),
  MERGE_WATCH_MIN: Joi.number().integer().min(1),
  RECOVER_WAIT_MS: Joi.number().integer().min(1),
  RETAIN_DONE_DAYS: Joi.number().integer().min(0),
  MIN_FREE_GB: Joi.number().min(0),
  DOCKER_PRUNE: Joi.boolean(),
  MAX_RUN_USD: Joi.number(),
  MAX_RUN_TOKENS: Joi.number().empty('').optional(),
  STEP_USD_MAX: Joi.number().empty('').optional(),
  STEP_TOKEN_MAX: Joi.number().empty('').optional(),
  IDLE_TIMEOUT_MS: Joi.number(),
  LOOP_REPEAT: Joi.number().integer().min(1),
  SANDBOX_EGRESS: Joi.string().valid('proxy', 'open'),
  SANDBOX_DOCKER_RUNTIME: Joi.string()
    .pattern(/^[a-z][a-z0-9_.-]{0,63}$/)
    .allow(''),
  PROJECT_HOSTS_ALLOW: Joi.string().allow(''),
  TICK_MS: Joi.number(),
  REQUIREMENTS_TIMEOUT_MS: Joi.number(),
  RESEARCH_TIMEOUT_MS: Joi.number(),
  PLAN_TIMEOUT_MS: Joi.number(),
  IMPLEMENT_TIMEOUT_MS: Joi.number(),
  CODE_REVIEW_TIMEOUT_MS: Joi.number(),
  MERGE_REQUEST_TIMEOUT_MS: Joi.number(),
  PIPELINE_TIMEOUT_MS: Joi.number(),
  PIPELINE_START_TIMEOUT_MS: Joi.number(),
  AGENTS_PLAN: mainAgents(),
  AGENTS_IMPLEMENT: mainAgents(),
  AGENTS_REVIEW: mainAgents(),
  AGENTS_SUBTASK_PLAN: Joi.string().allow(''),
  AGENTS_SUBTASK_IMPLEMENT: Joi.string().allow(''),
  AGENTS_SUBTASK_REVIEW: Joi.string().allow(''),
  EPIC_EFFORT: Joi.string().valid('', ...EFFORTS),
  SPLIT: Joi.string().valid('auto', 'off'),
  SPLIT_MAX_TASKS: Joi.number().integer().min(1),
  SUBTASKS_PARALLEL: Joi.number().integer().min(1),
  SWARMLOOP_ENV_FILE: Joi.string().allow(''),
  SWARMLOOP_REGISTRY: Joi.string().allow(''),
  SWARMLOOP_VERSION: Joi.string().allow(''),
  SWARMLOOP_UID: Joi.number().integer().min(1).empty(''),
  GIT_AUTHOR_NAME: Joi.string().allow(''),
  GIT_AUTHOR_EMAIL: Joi.string().allow(''),
  SWARMLOOP_ROOT: Joi.string().allow('').optional(),
  CHECKOUTS_ROOT: Joi.string().allow('').optional(),
  SWARMLOOP_API_PORT: Joi.number(),
  SWARMLOOP_API_HOST: Joi.string(),
  SWARMLOOP_PUBLIC_URL: Joi.string().uri(),
  SWARMLOOP_REPOS: Joi.string().allow(''),
  GITHUB_OAUTH_CLIENT_ID: Joi.string().allow(''),
  GITHUB_OAUTH_CLIENT_SECRET: Joi.string().allow(''),
  GITLAB_OAUTH_CLIENT_ID: Joi.string().allow(''),
  GITLAB_OAUTH_CLIENT_SECRET: Joi.string().allow(''),
  SWARMLOOP_ALLOW: Joi.string()
    .allow('')
    .custom((value: string) => {
      parseAllow(value);
      return value;
    }),
  SWARMLOOP_TOKEN: Joi.string().allow(''),
  SWARMLOOP_SECRET: Joi.string().allow(''),
}).messages({
  'any.only': '{{#label}} has unknown value {{#value}}',
});
