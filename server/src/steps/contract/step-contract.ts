import type { StepName } from '../../contract/steps';
import type { VisitDraft } from '../../history/visit';
import type { Artifact } from './artifact';

export type InputNeed = 'start' | 'run' | 'optional';

export type InputSpec = Record<string, { artifact: Artifact<unknown>; need: InputNeed }>;

/** Each input name with its parsed value, or null for an optional input that is not stored. */
export type StepInput<S extends InputSpec> = {
  [K in keyof S]: S[K]['need'] extends 'optional'
    ? ReturnType<S[K]['artifact']['parse']> | null
    : ReturnType<S[K]['artifact']['parse']>;
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
