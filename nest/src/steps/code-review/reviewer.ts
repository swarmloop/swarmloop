import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SwarmloopEnv } from '../../config/env';
import { HistoryService } from '../../history/history.service';
import { ExchangeDraft, SampleDraft } from '../../history/visit';
import { AgentProcessRunner, AgentRunResult, readSession } from '../../limits/agent-runner';
import { sessionFileName } from '../../limits/session-group';
import { OpenedStep } from '../../pipeline/step-run';
import { SandboxMount } from '../../sandbox/sandbox-launch';
import { SwarmloopError } from '../../swarmloop-error';
import { reviewContinue, reviewResume } from './code-review.prompts';
import { launchAgent } from '../agent-step';
import { agentFailure } from '../shared/agent-result';
import { handoffSection, textDocument } from '../shared/handoff';
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
  const prompt = fresh || !session?.chatId
    ? job.prompt
    : retry && !job.stale
      ? reviewContinue(job.reviewer.name)
      : reviewResume(job.reviewer.name, fix.implement, fix.reviewed, plan, returned);
  return one(deps, opened, key, env, { reviewer: job.reviewer, model: job.model, prompt, mounts: job.mounts }, auto, fresh);
}

/** One reviewer visit, with its own chart and exchange, the same shape as any other step. */
export async function recordAngle(deps: ReviewDeps, opened: OpenedStep, item: Finished, repeated = false): Promise<void> {
  const result = item.result;
  if (!result) {
    return;
  }
  const parsed = item.parsed && repeated && item.parsed.decision === 'return'
    ? { ...item.parsed, decision: 'ok' as const, body: decidedOk(item.parsed.body) }
    : item.parsed;
  const status = item.error ? 'failed' : parsed?.decision === 'return' ? 'waiting' : parsed ? 'done' : 'failed';
  const exchange = exchangeOf(item);
  const log = result.output ? (result.output.endsWith('\n') ? result.output : `${result.output}\n`) : '';
  await deps.history.finishVisit(opened.run, {
    step: `code-review-${item.reviewer.name}`,
    model: item.model,
    mode: 'ask',
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    status,
    exitCode: item.error ? 1 : 0,
    killReason: result.killReason ? `process killed: ${result.killReason}` : null,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    usd: result.usd,
    samples: result.samples,
    exchange,
    httpCalls: [],
    document: null,
    documents: [
      ...(parsed ? [textDocument(item.reviewer.kind, parsed.body)] : []),
      ...(item.error ? [{ kind: 'error', fileName: '', body: `${item.error}\n` }] : []),
      ...(log ? [{ kind: 'log', fileName: '', body: log }] : []),
    ],
    resumed: result.resumed,
  });
}

export function decidedOk(body: string): string {
  const lines = body.split('\n').filter((line) => line.trim() !== 'decision: return');
  return `${lines.join('\n').trimEnd()}\ndecision: ok\n`;
}

export function fixNotes(documents: { kind: string; body: string }[], handoff: string | null): { implement: string; reviewed: string } {
  const written = documents.filter((item) => item.kind === 'implementation' && item.body.trim()).map((item) => item.body.trim());
  const implementWhat = written.length >= 2 ? written[written.length - 2] : (written.at(-1) ?? '');
  const reviewWhat = written.length >= 2 ? (written.at(-1) ?? '') : '';
  const same = reviewWhat.length > 0 && reviewWhat === implementWhat;
  return {
    implement: passNote(implementWhat, handoffSection(handoff, 'implement')),
    reviewed: passNote(same ? '' : reviewWhat, handoffSection(handoff, 'implement-improve')),
  };
}

function passNote(what: string, why: string): string {
  const parts = [
    what.trim() ? `What was done:\n${what.trim()}` : '',
    why.trim() ? `Why:\n${why.trim()}` : '',
  ];
  return parts.filter((part) => part.length > 0).join('\n');
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
  try {
    const directory = join(deps.history.root(), 'data');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${key}-code-review-${job.reviewer.name}-output.txt`), 'starting\n');
    const result = await launchReview(deps, opened, key, env, job, auto, fresh);
    const failure = agentFailure(result, 'code-review');
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
    const message = error instanceof SwarmloopError ? error.message : 'code-review failed';
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

function exchangeOf(item: Finished): ExchangeDraft {
  const result = item.result;
  if (!result) {
    throw new SwarmloopError('code-review failed');
  }
  return {
    model: item.model,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    requestText: item.prompt,
    responseText: result.responseText,
    chatId: result.chatId,
    resumed: result.resumed,
    killReason: result.killReason,
  };
}
