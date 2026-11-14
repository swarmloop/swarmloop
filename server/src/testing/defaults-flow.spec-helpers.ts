import type { AgentRunInput, AgentRunResult } from '../agent/agent-runner';
import { optionalLimit, splitList, type SwarmloopEnv } from '../config/env';
import { shippedDefaults, validateSettings } from '../config/env.schema.spec-helpers';
import { result } from '../steps/plan/plan.step.spec-helpers';
import type { FakeAgentRunner } from './test-app';

/** What a default-only app takes from the harness and not from `defaults.env`: its own root, a free port and the machine token. */
export const ISOLATION_KEYS = ['SWARMLOOP_ROOT', 'SWARMLOOP_API_PORT', 'SWARMLOOP_TOKEN'] as const;

/** Settings of `defaults.env` that `AppConfig` does not carry: sandbox and git settings that other code reads from the process. */
export const OUTSIDE_APP_CONFIG = [
  'PROJECT_HOSTS_ALLOW',
  'SWARMLOOP_ENV_FILE',
  'SWARMLOOP_REGISTRY',
  'SWARMLOOP_VERSION',
  'SWARMLOOP_UID',
  'SWARMLOOP_API_URL',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
] as const;

/** `defaults.env` parsed on its own and validated by the schema, then turned the way `AppConfig` turns it. */
export function expectedEnv(isolation: Pick<SwarmloopEnv, (typeof ISOLATION_KEYS)[number]>): Record<string, unknown> {
  const raw = shippedDefaults();
  const { value, error } = validateSettings({}, { abortEarly: false, convert: true });
  if (error) throw error;
  const validated = { ...(value as Record<string, unknown>) };
  for (const key of OUTSIDE_APP_CONFIG) delete validated[key];
  return {
    ...validated,
    MAX_RUN_TOKENS: optionalLimit(raw.MAX_RUN_TOKENS),
    STEP_USD_MAX: optionalLimit(raw.STEP_USD_MAX),
    STEP_TOKEN_MAX: optionalLimit(raw.STEP_TOKEN_MAX),
    SWARMLOOP_REPOS: splitList(raw.SWARMLOOP_REPOS),
    CHECKOUTS_ROOT: raw.CHECKOUTS_ROOT || undefined,
    ...isolation,
  };
}

/** A split answer: one `id | title | depends | files | proof` line and a description for each task. */
export function tasksAnswer(tasks: { id: string; depends?: string }[]): string {
  const lines = tasks.flatMap(({ id, depends = 'none' }) => [
    `- ${id} | Task ${id} | depends: ${depends} | files: ${id}.ts | proof: ${id}.spec.ts`,
    `  Does ${id}.`,
  ]);
  return ['contract:', '- the field is called `split_on`', '', 'tasks:', ...lines, '', 'summary:', '- checked'].join(
    '\n',
  );
}

const COLUMN = { id: 'column' };
const API = { id: 'api', depends: 'column' };

/** The answers of the planning agent in order: the plan, the first check, and the check at the epic effort. */
const PLANNING_ANSWERS = [
  tasksAnswer([COLUMN, API]),
  tasksAnswer([COLUMN, API, { id: 'ui', depends: 'api' }]),
  tasksAnswer([COLUMN, API, { id: 'ui', depends: 'column' }]),
];

/** The agent of a split plan: each planning launch gets the next answer and is kept. The scripted steps get nothing. */
export class SplitPlanAgent implements FakeAgentRunner {
  readonly steps: string[] = [];
  readonly launches: AgentRunInput[] = [];

  run(step: string, input: AgentRunInput): Promise<AgentRunResult | undefined> {
    this.steps.push(step);
    if (step !== 'plan' && step !== 'plan-improve') return Promise.resolve(undefined);
    this.launches.push(input);
    return Promise.resolve(result(PLANNING_ANSWERS[this.launches.length - 1]));
  }
}
