import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { effortFields } from '../../contract/effort';
import type { EffortFields } from '../../contract/effort';
import type { SwarmloopEnv } from '../../config/env';
import type { DocumentRepository } from '../../history/document.repository';
import type { PlanChatEntry } from '../../contract/plan-chat';
import type { PlanChatStore } from '../../history/plan-chat.store';
import { answerFollowUp, takeAnswer } from '../implement/implement-question';
import { resultPromptFor } from '../../agent-result/result-prompt';
import type { VisitRepository } from '../../history/visit.repository';
import type { SampleDraft } from '../../history/visit';
import type { AgentRunResult } from '../../agent/agent-runner';
import type { LaunchResult } from '../shared/result-exchange';
import { resumableChat } from '../../agent/agent-session';
import type { OpenedStep } from '../../steps/step-run';
import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import type { SandboxMount } from '../../core/sandbox-mount';
import { reportFailure } from '../shared/step-failure';
import { RuntimeLimit, SwarmloopError } from '../../core/swarmloop-error';
import { reviewContinue, reviewResume } from './code-review.prompts';
import type { AgentLauncher } from '../shared/agent-launcher';
import { ResultInvalid } from '../shared/answer-errors';
import { agentFailure, refusedWrite, withRefusal } from '../shared/agent-result';
import { opinionOf } from './code-review-record';
import type { Opinion } from './code-review-record';
import { reviewAnswerDefinition, reviewDefinition } from '../../agent-result/definitions/review';
import type { ReviewResult } from '../../agent-result/definitions/review';
import { CODE_REVIEWERS } from '../../contract/steps';
import { REVIEWS } from '../contract/artifacts';
import type { RunReport } from '../shared/run-report';
import { storedAnswerErrors } from '../shared/stored-answer-errors';

export interface Reviewer {
  name: string;
  kind: string;
}

export interface Finished extends EffortFields {
  reviewer: Reviewer;
  runtime: RuntimeName;
  model: string;
  prompt: string;
  result: AgentRunResult | null;
  parsed?: Opinion;
  error?: string;
  answerErrors?: string[];
  /** The reviewer's launch ended on a provider limit and no agent of the role was left. */
  limit?: RuntimeLimit;
  /** The reviewer's question to the planner. Its decision is not taken: the round waits for the answer. */
  asked?: string;
  /** The reviewer read the planner's answer in this launch, so its decision is final for the round. */
  heard?: boolean;
}

/** One reviewer launch. `briefFor` is the full prompt for another runtime, whatever `prompt` is. */
interface ReviewLaunch extends EffortFields {
  reviewer: Reviewer;
  runtime: RuntimeName;
  model: string;
  prompt: string;
  mounts: SandboxMount[];
  briefFor: (runtime: RuntimeName) => string;
  /** The reviewer saw implement's answer to its last finding, so its result carries a `reason`. */
  answering: boolean;
  answerErrors?: string[];
  /** The server's check of the answer, made before it is accepted. */
  check?: (value: unknown) => string[];
  /** The planner's answer to the reviewer's last question, read once when the launch has returned. */
  answer: PlanChatEntry | null;
  /** The reviewer may ask the planner: it has no answer yet and the run has a planner of its own. */
  mayAsk: boolean;
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
  runReport: RunReport;
  chat?: PlanChatStore;
  /** Called when the report's own agent is about to start. */
  onReportStart?: () => void;
}

export const REVIEWERS: Reviewer[] = [...CODE_REVIEWERS.map((name) => ({ name, kind: REVIEWS.of(name) }))];

/** The reviewer a Run again names, when it is one of the reviewers. */
export function onlyReviewer(reviewer: string | undefined): string | undefined {
  return REVIEWERS.some((item) => item.name === reviewer) ? reviewer : undefined;
}

export async function runJob(
  deps: ReviewDeps,
  opened: OpenedStep,
  key: string,
  env: SwarmloopEnv,
  job: Omit<ReviewLaunch, 'briefFor' | 'answering'> & {
    promptFor: (runtime: RuntimeName) => string;
    exchange: { heading: string; body: string } | null;
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
  const full = fresh || !session?.chatId;
  const received = session?.resultName ?? null;
  const definition = job.exchange ? reviewAnswerDefinition(job.reviewer.name) : reviewDefinition(job.reviewer.name);
  const chosen = full
    ? job.prompt
    : job.answer
      ? answerFollowUp(job.answer, resultPromptFor(definition, received))
      : retry
        ? reviewContinue(job.reviewer.name, received)
        : reviewResume(
            job.reviewer.name,
            fix.implement,
            fix.reviewed,
            plan,
            returned,
            received,
            job.exchange ?? undefined,
          );
  return one(
    deps,
    opened,
    key,
    env,
    {
      reviewer: job.reviewer,
      runtime: job.runtime,
      model: job.model,
      ...effortFields(job),
      prompt: chosen,
      mounts: job.mounts,
      briefFor: job.promptFor,
      answering: job.exchange !== null,
      answerErrors: await storedAnswerErrors(deps, opened.run.id, step),
      check: job.check,
      answer: job.answer,
      mayAsk: job.mayAsk,
    },
    auto,
    fresh,
  );
}

async function one(
  deps: ReviewDeps,
  opened: OpenedStep,
  key: string,
  env: SwarmloopEnv,
  job: ReviewLaunch,
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
    const ran = {
      reviewer: job.reviewer,
      runtime: agent.runtime,
      model: agent.model,
      ...effortFields(agent),
      prompt: job.prompt,
      ...(job.answer ? { heard: true } : {}),
    };
    refused = refusedWrite(result.output);
    const failure = agentFailure(result, 'code-review', 'ask');
    if (failure) {
      return { ...ran, result, error: failure };
    }
    if (!result.resultValue) {
      throw new SwarmloopError('decision is missing');
    }
    await takeAnswer(deps.chat, key, job.answer);
    const value = result.resultValue as ReviewResult;
    if (job.mayAsk && value.question?.trim()) {
      return { ...ran, result, asked: value.question };
    }
    return { ...ran, result, parsed: opinionOf(job.reviewer.kind, value) };
  } catch (error) {
    if (error instanceof ResultInvalid) {
      refused = refusedWrite(error.output);
    }
    const message = withRefusal(reportFailure('code-review', error).message, refused);
    return {
      reviewer: job.reviewer,
      runtime: job.runtime,
      model: job.model,
      ...effortFields(job),
      prompt: job.prompt,
      result: error instanceof ResultInvalid ? (error.result ?? null) : null,
      error: message,
      ...(error instanceof ResultInvalid ? { answerErrors: error.errors } : {}),
      ...(error instanceof RuntimeLimit ? { limit: error } : {}),
    };
  }
}

async function launchReview(
  deps: ReviewDeps,
  opened: OpenedStep,
  key: string,
  env: SwarmloopEnv,
  job: ReviewLaunch,
  auto?: boolean,
  fresh = false,
): Promise<LaunchResult> {
  return deps.launcher.launch({
    root: deps.root,
    run: opened.run,
    key,
    step: `code-review-${job.reviewer.name}`,
    mode: 'ask',
    tools: 'read',
    runtime: job.runtime,
    model: job.model,
    ...effortFields(job),
    timeLimitMs: env.CODE_REVIEW_TIMEOUT_MS,
    prompt: job.prompt,
    continuePrompt: reviewContinue(job.reviewer.name),
    workspace: job.mounts[0]?.containerPath ?? '/work',
    mounts: job.mounts,
    auto,
    resume: fresh ? false : undefined,
    failover: true,
    brief: job.briefFor(job.runtime),
    // A resumed chat the CLI no longer has starts again from the whole prompt, with the whole result text.
    freshPrompt: job.briefFor(job.runtime),
    briefFor: job.briefFor,
    result: job.answering ? reviewAnswerDefinition(job.reviewer.name) : reviewDefinition(job.reviewer.name),
    answerErrors: job.answerErrors,
    check: job.check,
  });
}
