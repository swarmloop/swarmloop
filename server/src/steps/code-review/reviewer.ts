import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { SwarmloopEnv } from '../../config/env';
import type { DocumentRepository } from '../../history/document.repository';
import type { VisitRepository } from '../../history/visit.repository';
import type { SampleDraft } from '../../history/visit';
import type { AgentRunResult } from '../../agent/agent-runner';
import { readSession } from '../../agent/agent-runner';
import { sessionFileName } from '../../history/session-group';
import type { OpenedStep } from '../../steps/step-run';
import type { SandboxMount } from '../../core/sandbox-mount';
import { SwarmloopError } from '../../core/swarmloop-error';
import { reviewContinue, reviewResume } from './code-review.prompts';
import type { AgentLauncher } from '../shared/agent-launcher';
import { agentFailure, refusedWrite, withRefusal } from '../shared/agent-result';
import { parseReview } from './code-review-record';
import { CODE_REVIEWERS } from '../../contract/steps';
import { REVIEWS } from '../contract/artifacts';

export interface Reviewer {
  name: string;
  kind: string;
}

export interface Opinion {
  kind: string;
  decision: 'ok' | 'return';
  body: string;
}

export interface Finished {
  reviewer: Reviewer;
  model: string;
  prompt: string;
  result: AgentRunResult | null;
  parsed?: Opinion;
  error?: string;
}

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  usd: number;
  samples: SampleDraft[];
}

export interface ReviewDeps {
  documents: DocumentRepository;
  visits: VisitRepository;
  root: string;
  launcher: AgentLauncher;
}

/** The model every reviewer and the report run on. */
export function reviewModel(env: SwarmloopEnv): string {
  return env.MODEL_PLAN;
}

export const REVIEWERS: Reviewer[] = [...CODE_REVIEWERS.map((name) => ({ name, kind: REVIEWS.of(name) }))];

export async function runJob(
  deps: ReviewDeps,
  opened: OpenedStep,
  key: string,
  env: SwarmloopEnv,
  job: {
    reviewer: Reviewer;
    model: string;
    prompt: string;
    mounts: SandboxMount[];
    stale: boolean;
  },
  fix: { implement: string; reviewed: string },
  plan: string,
  returned: string | null,
  auto: boolean | undefined,
  fresh: boolean,
  retry: boolean,
): Promise<Finished> {
  const step = `code-review-${job.reviewer.name}`;
  const session = await readSession(join(deps.root, 'data', sessionFileName(key, step)), opened.run.runtime);
  const chosen =
    fresh || !session?.chatId
      ? job.prompt
      : retry && !job.stale
        ? reviewContinue(job.reviewer.name)
        : reviewResume(job.reviewer.name, fix.implement, fix.reviewed, plan, returned);
  const prompt = chosen;
  return one(
    deps,
    opened,
    key,
    env,
    { reviewer: job.reviewer, model: job.model, prompt, mounts: job.mounts },
    auto,
    fresh,
  );
}

export function decidedOk(body: string): string {
  const lines = body.split('\n').filter((line) => !/^decision:\s*return\b/.test(line.trim()));
  return `${lines.join('\n').trimEnd()}\ndecision: ok\n`;
}

async function one(
  deps: ReviewDeps,
  opened: OpenedStep,
  key: string,
  env: SwarmloopEnv,
  job: { reviewer: Reviewer; model: string; prompt: string; mounts: SandboxMount[] },
  auto?: boolean,
  fresh = false,
): Promise<Finished> {
  let refused: string | null = null;
  try {
    const directory = join(deps.root, 'data');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${key}-code-review-${job.reviewer.name}-output.txt`), 'starting\n');
    const result = await launchReview(deps, opened, key, env, job, auto, fresh);
    refused = refusedWrite(result.output);
    const failure = agentFailure(result, 'code-review', 'ask');
    if (failure) {
      return { reviewer: job.reviewer, model: job.model, prompt: job.prompt, result, error: failure };
    }
    const parsed = parseReview(result.responseText, result.output ?? '');
    return {
      reviewer: job.reviewer,
      model: job.model,
      prompt: job.prompt,
      result,
      parsed: { kind: job.reviewer.kind, decision: parsed.decision, body: parsed.body },
    };
  } catch (error) {
    const message = error instanceof SwarmloopError ? withRefusal(error.message, refused) : 'code-review failed';
    return { reviewer: job.reviewer, model: job.model, prompt: job.prompt, result: null, error: message };
  }
}

async function launchReview(
  deps: ReviewDeps,
  opened: OpenedStep,
  key: string,
  env: SwarmloopEnv,
  job: { reviewer: Reviewer; model: string; prompt: string; mounts: SandboxMount[] },
  auto?: boolean,
  fresh = false,
): Promise<AgentRunResult> {
  return deps.launcher.launch({
    root: deps.root,
    run: opened.run,
    key,
    step: `code-review-${job.reviewer.name}`,
    mode: 'ask',
    model: job.model,
    timeLimitMs: env.CODE_REVIEW_TIMEOUT_MS,
    prompt: job.prompt,
    continuePrompt: reviewContinue(job.reviewer.name),
    workspace: job.mounts[0]?.containerPath ?? '/work',
    mounts: job.mounts,
    auto,
    resume: fresh ? false : undefined,
  });
}
