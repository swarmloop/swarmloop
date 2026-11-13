import Joi from 'joi';
import { parseAllow } from '../auth/allow-list';
import { EFFORTS } from '../contract/effort';
import { IssueTrackerRegistry } from '../integrations/issue-tracker/issue-tracker.registry';
import { names } from '../integrations/requirements-source/requirements-source.registry';

const MAIN_AGENTS_MISSING = '{{#key}} is missing: set it as in .env.example';

/** A main agent list has no default: an empty or missing one is a start-up error. */
function mainAgents(): Joi.StringSchema {
  return Joi.string().required().messages({ 'any.required': MAIN_AGENTS_MISSING, 'string.empty': MAIN_AGENTS_MISSING });
}

export const envSchema = Joi.object({
  REQUIREMENTS_VIA: Joi.string()
    .valid(...names)
    .required(),
  ISSUE_TRACKER: Joi.string()
    .valid(...IssueTrackerRegistry.names)
    .required(),
  JIRA_BASE_URL: Joi.string().allow('').required(),
  JIRA_EMAIL: Joi.string().allow('').required(),
  JIRA_API_TOKEN: Joi.string().allow('').required(),
  JIRA_PROJECTS: Joi.string().allow('').default(''),
  GITLAB_BASE_URL: Joi.string().allow('').required(),
  GITLAB_TOKEN: Joi.string().allow('').required(),
  GITHUB_BASE_URL: Joi.string().allow('').required(),
  GITHUB_TOKEN: Joi.string().allow('').required(),
  CURSOR_API_KEY: Joi.string().allow('').required(),
  ANTHROPIC_API_KEY: Joi.string().allow('').required(),
  CLAUDE_CODE_OAUTH_TOKEN: Joi.string().allow('').default(''),
  CODEX_AUTH: Joi.string().allow('').default(''),
  CODEX_API_KEY: Joi.string().allow('').default(''),
  MAX_AGENT_CALLS: Joi.number().required(),
  MAX_RETURNS: Joi.number().integer().min(1).required(),
  MAX_PIPELINE_RETURNS: Joi.number().integer().min(1).default(6),
  MAX_LAUNCHES: Joi.number().integer().min(1).required(),
  CHECKS_PARALLEL: Joi.number().integer().min(1).default(3),
  RESERVE_CPUS: Joi.number().min(0).default(1),
  RESERVE_MEMORY_GB: Joi.number().min(0).default(2),
  LIMIT_COOLDOWN_MIN: Joi.number().integer().min(1).default(60),
  STOP_GRACE_S: Joi.number().integer().min(1).default(10),
  RECONCILE_MS: Joi.number().integer().min(1).default(60_000),
  MERGE_WATCH_MIN: Joi.number().integer().min(1).default(5),
  RECOVER_WAIT_MS: Joi.number().integer().min(1).default(600_000),
  RETAIN_DONE_DAYS: Joi.number().integer().min(0).default(3),
  MIN_FREE_GB: Joi.number().min(0).default(10),
  DOCKER_PRUNE: Joi.boolean().default(true),
  MAX_RUN_USD: Joi.number().required(),
  MAX_RUN_TOKENS: Joi.number().empty('').optional(),
  STEP_USD_MAX: Joi.number().empty('').optional(),
  STEP_TOKEN_MAX: Joi.number().empty('').optional(),
  IDLE_TIMEOUT_MS: Joi.number().required(),
  LOOP_REPEAT: Joi.number().integer().min(1).default(4),
  SANDBOX_EGRESS: Joi.string().valid('proxy', 'open').default('proxy'),
  SANDBOX_DOCKER_RUNTIME: Joi.string()
    .pattern(/^[a-z][a-z0-9_.-]{0,63}$/)
    .allow('')
    .default(''),
  PROJECT_HOSTS_ALLOW: Joi.string().allow('').default(''),
  TICK_MS: Joi.number().required(),
  REQUIREMENTS_TIMEOUT_MS: Joi.number().required(),
  RESEARCH_TIMEOUT_MS: Joi.number().required(),
  PLAN_TIMEOUT_MS: Joi.number().required(),
  IMPLEMENT_TIMEOUT_MS: Joi.number().required(),
  CODE_REVIEW_TIMEOUT_MS: Joi.number().required(),
  MERGE_REQUEST_TIMEOUT_MS: Joi.number().required(),
  PIPELINE_TIMEOUT_MS: Joi.number().required(),
  PIPELINE_START_TIMEOUT_MS: Joi.number().required(),
  AGENTS_PLAN: mainAgents(),
  AGENTS_IMPLEMENT: mainAgents(),
  AGENTS_REVIEW: mainAgents(),
  AGENTS_SUBTASK_PLAN: Joi.string().allow('').default(''),
  AGENTS_SUBTASK_IMPLEMENT: Joi.string().allow('').default(''),
  AGENTS_SUBTASK_REVIEW: Joi.string().allow('').default(''),
  EPIC_EFFORT: Joi.string()
    .valid('', ...EFFORTS)
    .default('xhigh'),
  SPLIT: Joi.string().valid('auto', 'off').default('auto'),
  SPLIT_MAX_TASKS: Joi.number().integer().min(1).default(48),
  SUBTASKS_PARALLEL: Joi.number().integer().min(1).default(3),
  SWARMLOOP_ROOT: Joi.string().allow('').optional(),
  CHECKOUTS_ROOT: Joi.string().allow('').optional(),
  SWARMLOOP_API_PORT: Joi.number().required(),
  SWARMLOOP_API_HOST: Joi.string().required(),
  SWARMLOOP_PUBLIC_URL: Joi.string().uri().default('http://127.0.0.1:3921'),
  SWARMLOOP_REPOS: Joi.string().allow('').default(''),
  GITHUB_OAUTH_CLIENT_ID: Joi.string().allow('').default(''),
  GITHUB_OAUTH_CLIENT_SECRET: Joi.string().allow('').default(''),
  GITLAB_OAUTH_CLIENT_ID: Joi.string().allow('').default(''),
  GITLAB_OAUTH_CLIENT_SECRET: Joi.string().allow('').default(''),
  SWARMLOOP_ALLOW: Joi.string()
    .allow('')
    .default('')
    .custom((value: string) => {
      parseAllow(value);
      return value;
    }),
  SWARMLOOP_TOKEN: Joi.string().allow('').default(''),
  SWARMLOOP_SECRET: Joi.string().allow('').default(''),
}).messages({
  'any.required': '{{#label}} is missing',
  'any.only': '{{#label}} has unknown value {{#value}}',
});
