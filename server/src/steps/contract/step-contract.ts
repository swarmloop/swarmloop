import type { StepName } from '../../contract/steps';
import type { PipelineResult } from '../../core/pipeline-result';
import type { VisitDraft } from '../../history/visit';
import type { Artifact } from './artifact';

export type InputNeed = 'start' | 'run' | 'optional';

/**
 * A `late` input is declared but not loaded by `read`: the step loads it with `ctx.reread` at the point it needs it,
 * so a visit that stops earlier never reads it.
 */
export type InputSpec = Record<string, { artifact: Artifact<unknown>; need: InputNeed; late?: boolean }>;

/**
 * Each loaded input name with its parsed value. Only a `run` input is always there: a `start` input is checked
 * before the step is asked to run, and a visit that is not gated can still find it absent.
 */
export type StepInput<S extends InputSpec> = {
  [K in keyof S as S[K] extends { late: true } ? never : K]: S[K]['need'] extends 'run'
    ? ReturnType<S[K]['artifact']['parse']>
    : ReturnType<S[K]['artifact']['parse']> | null;
};

export interface Issue {
  id: string;
  source: string;
  title: string;
  body: string;
}

export interface StepFailure {
  code: string;
  message: string;
}

export type Route =
  | { to: 'next' }
  | { to: 'jump'; step: StepName }
  | { to: 'return'; step: StepName; issues: Issue[] }
  | { to: 'wait'; reason: string }
  | { to: 'block'; reason: string }
  | { to: 'fail'; error: StepFailure };

export interface ArtifactValue {
  artifact: Artifact<unknown>;
  value: unknown;
}

export interface StepResult {
  route: Route;
  summary: string;
  outputs: ArtifactValue[];
  handoff?: string;
  exitCode?: number;
  visit?: Partial<VisitDraft>;
  /** Runs once the visit is closed, and may replace the result the step returns. */
  afterClose?(ended: PipelineResult): Promise<PipelineResult>;
}

export interface StepCapabilities {
  /** Takes instructions as its prompt. */
  prompt?: boolean;
  /** Takes a checkout path. */
  path?: boolean;
  /** Takes the project list when it starts. */
  projects?: boolean;
  /** Instructions given to this step revise the requirements document. */
  revisesRequirements?: boolean;
}

export interface AgentProfile {
  runtime: string;
  model: string;
  mode: string;
  timeLimitMs: number;
  session: 'resume' | 'fresh';
}

export interface StepDescriptor {
  name: StepName;
  kind: 'server' | 'agent';
  inputs: { name: string; kind: string; need: InputNeed }[];
  outputs: string[];
  capabilities: StepCapabilities;
  agent?: AgentProfile;
  reviewers?: { name: string; model: string }[];
}
