import { agentFor } from '../../config/agents';
import { mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import type { SwarmloopEnv } from '../../config/env';
import type { DocumentRepository } from '../../history/document.repository';
import type { DocumentDraft, ExchangeDraft } from '../../history/visit';
import type { OpenedStep } from '../../steps/step-run';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { PipelineResult } from '../../core/pipeline-result';
import { visitStatus } from '../../core/pipeline-result';
import { reportFailure } from '../shared/step-failure';
import { RuntimeLimit, SwarmloopError } from '../../core/swarmloop-error';
import type { StepContext } from '../base-step';
import { assertRoute } from '../contract/returns';
import { routeToEnd } from '../contract/route';
import type { Route } from '../contract/step-contract';
import { agentFailure } from '../shared/agent-result';
import { projectRules } from '../shared/project-rules';
import { appendImpact, mergeHandoff, textDocument, withImpact } from '../shared/handoff';
import { plainSummary, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { REPORT_CONTINUE, reportFollowUp } from './code-review.prompts';
import { decidedOk } from './reviewer';
import type { Finished, Opinion, ReviewDeps, Usage } from './reviewer';
import { ARTIFACTS, REVIEWS } from '../contract/artifacts';
import { answerEnding } from '../shared/parse-failure-follow-up';

const LABELS: Record<string, string> = {
  [REVIEWS.of('requirements')]: 'Requirements',
  [REVIEWS.of('quality')]: 'Quality',
  [REVIEWS.of('regressions')]: 'Regressions',
  [REVIEWS.of('security')]: 'Security',
  [REVIEWS.of('performance')]: 'Performance',
};

export function reviewBrief(opinions: { kind: string; decision: 'ok' | 'return'; body: string }[]): string {
  return opinions
    .map((opinion) => {
      const name = LABELS[opinion.kind] ?? opinion.kind.slice(REVIEWS.prefix.length);
      return [`## ${name}`, `decision: ${opinion.decision}`, '', opinion.body.trimEnd()].join('\n');
    })
    .join('\n\n');
}

export async function writeReport(
  deps: ReviewDeps,
  opened: OpenedStep,
  key: string,
  env: SwarmloopEnv,
  opinions: Opinion[],
  mounts: SandboxMount[],
  requirements: string,
  implementation: string | null,
  impact: string | null,
  continued: boolean,
  auto?: boolean,
): Promise<
  | { document: DocumentDraft; exchange: ExchangeDraft; usage: Usage }
  | { error: string; exchange: ExchangeDraft | null; usage: Usage }
> {
  const names = mounts.map((mount) => basename(mount.hostPath));
  const brief = reviewBrief(opinions);
  const sections = withImpact(
    [
      ...(implementation?.trim() ? [{ heading: 'Implementation', body: implementation }] : []),
      { heading: 'Reviews', body: brief },
    ],
    impact,
  );
  const fullFor = (runtime: string): string =>
    skillPrompt('code-review/report', requirements, names, sections, mounts, {
      rules: projectRules(names, mounts, runtime, false),
    });
  const asked = agentFor(env, opened.run, 'code-review-report');
  const full = fullFor(asked.runtime);
  const prompt = continued ? appendImpact(reportFollowUp(brief, implementation), impact) : full;
  const empty: Usage = { tokensIn: 0, tokensOut: 0, usd: 0, samples: [] };
  try {
    const directory = join(deps.root, 'data');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${key}-code-review-report-output.txt`), 'starting\n');
    const result = await deps.launcher.launch({
      root: deps.root,
      run: opened.run,
      key,
      step: 'code-review-report',
      mode: 'ask',
      tools: 'read',
      ...asked,
      timeLimitMs: env.CODE_REVIEW_TIMEOUT_MS,
      prompt,
      failover: true,
      brief: full,
      briefFor: fullFor,
      workspace: mounts[0]?.containerPath ?? '/work',
      mounts,
      auto,
      resume: false,
      continuePrompt: REPORT_CONTINUE,
      validate: (text) => {
        if (!text.trim()) {
          throw new SwarmloopError('review report is empty');
        }
      },
      parseFailureEnding: answerEnding('code-review/report'),
    });
    const { runtime, model } = result.agent ?? asked;
    const exchange: ExchangeDraft = {
      runtime,
      model,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      requestText: prompt,
      responseText: result.responseText,
      chatId: result.chatId,
      resumed: result.resumed,
      killReason: result.killReason,
    };
    const spent: Usage = {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      usd: result.usd,
      samples: result.samples,
    };
    const failure = agentFailure(result, 'code-review', 'ask');
    if (failure) {
      return { error: failure, exchange, usage: spent };
    }
    const text = result.responseText.trim();
    if (!text) {
      return { error: 'code-review report is empty', exchange, usage: spent };
    }
    return { document: textDocument(ARTIFACTS.reviewReport.kind, `${text}\n`), exchange, usage: spent };
  } catch (error) {
    if (error instanceof RuntimeLimit) {
      throw error;
    }
    const message = reportFailure('code-review', error, env).message;
    return { error: message, exchange: null, usage: empty };
  }
}

/** One reviewer visit, with its own chart and exchange, the same shape as any other step. */
export async function recordAngle(
  deps: ReviewDeps,
  opened: OpenedStep,
  item: Finished,
  repeated = false,
): Promise<void> {
  const result = item.result;
  if (!result) {
    return;
  }
  const parsed =
    item.parsed && repeated && item.parsed.decision === 'return'
      ? { ...item.parsed, decision: 'ok' as const, body: decidedOk(item.parsed.body) }
      : item.parsed;
  const status = item.error ? 'failed' : parsed?.decision === 'return' ? 'waiting' : parsed ? 'done' : 'failed';
  const exchange = exchangeOf(item);
  await deps.visits.finishVisit(opened.run, {
    step: `code-review-${item.reviewer.name}`,
    runtime: item.runtime,
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
      ...(item.error ? [{ kind: ARTIFACTS.error.kind, fileName: '', body: `${item.error}\n` }] : []),
    ],
    resumed: result.resumed,
  });
}

/** Adds each opinion's handoff summary to the handoff record, in the order given. */
export async function noteHandoff(
  documents: DocumentRepository,
  key: string,
  opinions: Opinion[],
  drafts: DocumentDraft[],
): Promise<DocumentDraft[]> {
  if (opinions.length === 0) {
    return drafts;
  }
  let text = (await documents.latestBody(key, ARTIFACTS.handoff.kind)) ?? '';
  for (const opinion of opinions) {
    const step = opinion.kind.slice(REVIEWS.prefix.length);
    text = mergeHandoff(text, step, summaryOr(opinion.body, plainSummary(opinion.body) || `- ${opinion.decision}`));
  }
  return [...drafts, textDocument(ARTIFACTS.handoff.kind, text)];
}

export function failed(message: string): Route {
  return { to: 'fail', error: { code: 'code-review', message } };
}

/** Closes the code-review visit with its documents, exchanges and usage. */
export function closeReview(
  ctx: StepContext,
  route: Route,
  line: string,
  documents: DocumentDraft[],
  exchanges: ExchangeDraft[],
  usage: Usage = { tokensIn: 0, tokensOut: 0, usd: 0, samples: [] },
): Promise<PipelineResult> {
  const { opened } = ctx;
  assertRoute('code-review', route);
  const { outcome, exitCode, moveTo } = routeToEnd(route);
  const decisions = documents
    .filter((document) => REVIEWS.matches(document.kind))
    .map(
      (document) =>
        `${document.kind.slice(REVIEWS.prefix.length)}: ${/^decision:\s*(\w+)/m.exec(document.body)?.[1] ?? 'none'}`,
    );
  return ctx.end({
    outcome,
    ...(decisions.length > 0 ? { facts: { details: decisions } } : {}),
    exitCode,
    line,
    moveTo,
    ...(route.to === 'wait' ? { code: route.code, limit: route.limit } : {}),
    visit: {
      step: 'code-review',
      runtime: exchanges.find((exchange) => exchange.runtime)?.runtime ?? null,
      model: exchanges.find((exchange) => exchange.model)?.model ?? null,
      mode: 'ask',
      startedAt: opened.startedAt,
      finishedAt: ctx.clock.iso(),
      durationMs: ctx.clock.now() - opened.started,
      status: visitStatus(outcome),
      exitCode,
      killReason: exchanges.find((exchange) => exchange.killReason)?.killReason ?? null,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      usd: usage.usd,
      samples: usage.samples,
      exchange: null,
      exchanges,
      httpCalls: [],
      document: null,
      documents,
      resumed: false,
    },
  });
}

function exchangeOf(item: Finished): ExchangeDraft {
  const result = item.result;
  if (!result) {
    throw new SwarmloopError('code-review failed');
  }
  return {
    runtime: item.runtime,
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
