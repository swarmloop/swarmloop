import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { SwarmloopEnv } from '../../config/env';
import type { HistoryService } from '../../history/history.service';
import type { SampleDraft } from '../../history/visit';
import type { AgentProcessRunner, AgentRunResult } from '../../agent/agent-runner';
import { readSession } from '../../agent/agent-runner';
import { sessionFileName } from '../../agent/session-group';
import type { OpenedStep } from '../../pipeline/step-run';
import type { SandboxMount } from '../../sandbox/sandbox-launch';
import { SwarmloopError } from '../../core/swarmloop-error';
import { reviewContinue, reviewResume } from './code-review.prompts';
import { launchAgent } from '../agent-step';
import { agentFailure, refusedWrite, withRefusal } from '../shared/agent-result';
import { parseReview } from './code-review-record';

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
  history: HistoryService;
  agent: AgentProcessRunner;
}

export const REVIEWERS: Reviewer[] = [
  { name: 'requirements', kind: 'review_requirements' },
  { name: 'quality', kind: 'review_quality' },
  { name: 'regressions', kind: 'review_regressions' },
  { name: 'security', kind: 'review_security' },
  { name: 'performance', kind: 'review_performance' },
];

export async function runJob(
  deps: ReviewDeps,
  opened: OpenedStep,
  key: string,
  env: SwarmloopEnv,
  job: { reviewer: Reviewer; model: string; prompt: string; mounts: SandboxMount[]; stale: boolean },
  fix: { implement: string; reviewed: string },
  plan: string,
  returned: string | null,
  auto: boolean | undefined,
  fresh: boolean,
  retry: boolean,
): Promise<Finished> {
  const step = `code-review-${job.reviewer.name}`;
  const session = await readSession(join(deps.history.root(), 'data', sessionFileName(key, step)), opened.run.runtime);
  const prompt =
    fresh || !session?.chatId
      ? job.prompt
      : retry && !job.stale
        ? reviewContinue(job.reviewer.name)
        : reviewResume(job.reviewer.name, fix.implement, fix.reviewed, plan, returned);
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
  const lines = body.split('\n').filter((line) => line.trim() !== 'decision: return');
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
    const directory = join(deps.history.root(), 'data');
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
  return launchAgent({
    agent: deps.agent,
    history: deps.history,
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
