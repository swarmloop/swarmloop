import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { SwarmloopEnv } from '../../config/env';
import type { DocumentRepository } from '../../history/document.repository';
import type { VisitRepository } from '../../history/visit.repository';
import type { SampleDraft } from '../../history/visit';
import type { AgentRunResult } from '../../agent/agent-runner';
import { resumableChat } from '../../agent/agent-session';
import type { OpenedStep } from '../../steps/step-run';
import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import type { SandboxMount } from '../../core/sandbox-mount';
import { reportFailure } from '../shared/step-failure';
import { RuntimeLimit } from '../../core/swarmloop-error';
import { reviewContinue, reviewResume } from './code-review.prompts';
import type { AgentLauncher } from '../shared/agent-launcher';
import { agentFailure, refusedWrite, withRefusal } from '../shared/agent-result';
import { parseReview } from './code-review-record';
import { CODE_REVIEWERS } from '../../contract/steps';
import { REVIEWS } from '../contract/artifacts';
import { answerEnding } from '../shared/parse-failure-follow-up';

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
  runtime: RuntimeName;
  model: string;
  prompt: string;
  result: AgentRunResult | null;
  parsed?: Opinion;
  error?: string;
  /** The reviewer's launch ended on a provider limit and no agent of the role was left. */
  limit?: RuntimeLimit;
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

export const REVIEWERS: Reviewer[] = [...CODE_REVIEWERS.map((name) => ({ name, kind: REVIEWS.of(name) }))];

export async function runJob(
  deps: ReviewDeps,
  opened: OpenedStep,
  key: string,
  env: SwarmloopEnv,
  job: {
    reviewer: Reviewer;
    runtime: RuntimeName;
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
  const session = await resumableChat(deps.root, key, step, job.runtime);
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
    { reviewer: job.reviewer, runtime: job.runtime, model: job.model, prompt, mounts: job.mounts },
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
  job: { reviewer: Reviewer; runtime: RuntimeName; model: string; prompt: string; mounts: SandboxMount[] },
  auto?: boolean,
  fresh = false,
): Promise<Finished> {
  let refused: string | null = null;
  try {
    const directory = join(deps.root, 'data');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${key}-code-review-${job.reviewer.name}-output.txt`), 'starting\n');
    const result = await launchReview(deps, opened, key, env, job, auto, fresh);
    // A reviewer that took over from a limited agent is recorded and priced as the agent that ran.
    const agent = result.agent ?? job;
    const ran = { reviewer: job.reviewer, runtime: agent.runtime, model: agent.model, prompt: job.prompt };
    refused = refusedWrite(result.output);
    const failure = agentFailure(result, 'code-review', 'ask');
    if (failure) {
      return { ...ran, result, error: failure };
    }
    const parsed = parseReview(result.responseText, result.output ?? '');
    return { ...ran, result, parsed: { kind: job.reviewer.kind, decision: parsed.decision, body: parsed.body } };
  } catch (error) {
    const message = withRefusal(reportFailure('code-review', error, env).message, refused);
    return {
      reviewer: job.reviewer,
      runtime: job.runtime,
      model: job.model,
      prompt: job.prompt,
      result: null,
      error: message,
      ...(error instanceof RuntimeLimit ? { limit: error } : {}),
    };
  }
}

async function launchReview(
  deps: ReviewDeps,
  opened: OpenedStep,
  key: string,
  env: SwarmloopEnv,
  job: { reviewer: Reviewer; runtime: RuntimeName; model: string; prompt: string; mounts: SandboxMount[] },
  auto?: boolean,
  fresh = false,
): Promise<AgentRunResult> {
  return deps.launcher.launch({
    root: deps.root,
    run: opened.run,
    key,
    step: `code-review-${job.reviewer.name}`,
    mode: 'ask',
    tools: 'read',
    runtime: job.runtime,
    model: job.model,
    timeLimitMs: env.CODE_REVIEW_TIMEOUT_MS,
    prompt: job.prompt,
    continuePrompt: reviewContinue(job.reviewer.name),
    workspace: job.mounts[0]?.containerPath ?? '/work',
    mounts: job.mounts,
    auto,
    resume: fresh ? false : undefined,
    failover: true,
    brief: job.prompt,
    validate: (text, output) => parseReview(text, output ?? ''),
    parseFailureEnding: answerEnding('code-review'),
  });
}
