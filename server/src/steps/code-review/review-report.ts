import { effortFields } from '../../contract/effort';
import { agentFor } from '../../config/agents';
import { mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import type { AgentRunResult } from '../../agent/agent-result';
import type { SwarmloopEnv } from '../../config/env';
import type { DocumentRepository } from '../../history/document.repository';
import type { DocumentDraft, ExchangeDraft } from '../../history/visit';
import type { OpenedStep } from '../../steps/step-run';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { PipelineResult } from '../../core/pipeline-result';
import { runFileName } from '../../core/run-files';
import { visitStatus } from '../../core/pipeline-result';
import { reportFailure } from '../shared/step-failure';
import { HostUnavailable, RuntimeLimit, SwarmloopError } from '../../core/swarmloop-error';
import { HOST_VISIT } from '../shared/model-host-unavailable';
import type { StepContext } from '../base-step';
import { assertRoute } from '../contract/returns';
import { routeToEnd } from '../contract/route';
import type { Route } from '../contract/step-contract';
import { agentFailure } from '../shared/agent-result';
import { projectRules } from '../shared/project-rules';
import { appendImpact, mergeHandoff, textDocument, withImpact } from '../shared/handoff';
import { skillPrompt } from '../shared/skill-prompt';
import { agentExchange, visitKillReason } from '../shared/model-visit';
import { REPORT_CONTINUE, reportFollowUp } from './code-review.prompts';
import { reportDocuments, reviewDocuments, summaryNote } from './code-review-record';
import type { Opinion } from './code-review-record';
import type { Exchange } from './review-exchange';
import type { Requirement } from '../../contract/requirement-list';
import { requirementsSection } from '../shared/coverage-correction';
import type { Finished, ReviewDeps, Usage } from './reviewer';
import { ARTIFACTS, REVIEWS } from '../contract/artifacts';
import { reviewReport } from '../../agent-result/definitions/review-report';
import type { ReviewReportResult } from '../../agent-result/definitions/review-report';
import { resultPromptFor } from '../../agent-result/result-prompt';
import { storedReview } from '../../agent-result/stored-review';
import { LABELS } from '../shared/reviewer-labels';
import { ResultInvalid } from '../shared/answer-errors';
import { StartRefused } from '../shared/start-refused';
import { StepStopped } from '../../agent/step-stopped';
import { answerErrorsDocument } from '../shared/stored-answer-errors';

export function usageOf(result: AgentRunResult): Usage {
  return { tokensIn: result.tokensIn, tokensOut: result.tokensOut, usd: result.usd, samples: result.samples };
}

export function reviewBrief(
  opinions: { kind: string; decision: 'ok' | 'return'; body: string }[],
  exchanges: ReadonlyMap<string, Exchange> = new Map(),
): string {
  return opinions
    .map((opinion) => {
      const name = LABELS[opinion.kind] ?? opinion.kind.slice(REVIEWS.prefix.length);
      const answer = exchanges.get(opinion.kind.slice(REVIEWS.prefix.length))?.answer?.trim();
      return [
        `## ${name}`,
        `decision: ${opinion.decision}`,
        '',
        opinion.body.trimEnd(),
        ...(answer ? ['', `Implement answered: ${answer}`] : []),
      ].join('\n');
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
  list: Requirement[] | null,
  continued: boolean,
  auto?: boolean,
  answerErrors?: string[],
  exchanges?: ReadonlyMap<string, Exchange>,
): Promise<
  | { documents: DocumentDraft[]; exchange: ExchangeDraft; usage: Usage; startId?: string }
  | { error: string; exchange: ExchangeDraft | null; usage: Usage; documents: DocumentDraft[]; startId?: string }
> {
  const names = mounts.map((mount) => basename(mount.hostPath));
  const brief = reviewBrief(opinions, exchanges);
  const sections = withImpact(
    [
      ...(implementation?.trim() ? [{ heading: 'Implementation', body: implementation }] : []),
      { heading: 'Reviews', body: brief },
      ...(list ? [requirementsSection(list)] : []),
    ],
    impact,
  );
  // The report never resumes a chat, so every prompt of it gets the full result text.
  const fullFor = (runtime: string): string =>
    [
      skillPrompt('code-review/report', requirements, names, sections, mounts, {
        rules: projectRules(names, mounts, runtime, false),
      }),
      resultPromptFor(reviewReport, null),
    ].join('\n\n');
  const asked = agentFor(env, opened.run, 'code-review-report');
  const full = fullFor(asked.runtime);
  const prompt = continued
    ? appendImpact(reportFollowUp(brief, implementation, list ? requirementsSection(list) : null), impact)
    : full;
  const empty: Usage = { tokensIn: 0, tokensOut: 0, usd: 0, samples: [] };
  let startId: string | undefined;
  try {
    const directory = join(deps.root, 'data');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, runFileName(key, 'code-review-report', 'output')), 'starting\n');
    deps.onReportStart?.();
    const { by, level } = deps.start;
    const input = { visitOf: 'code-review' as const, prompt: deps.start.prompt, texts: [brief] };
    const result = await deps.door.outside(
      { step: 'code-review-report', by, level, input, admitted: (id) => (startId = id) },
      {
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
        result: reviewReport,
        answerErrors,
      },
    );
    const { runtime, model, ...effort } = result.agent ?? asked;
    const exchange: ExchangeDraft = { runtime, ...effortFields(effort), ...agentExchange(result, model, prompt) };
    const spent = usageOf(result);
    const failure = agentFailure(result, 'code-review', 'ask');
    if (failure) {
      return { error: failure, exchange, usage: spent, documents: [], startId };
    }
    if (!result.resultValue) {
      return { error: 'code-review report is empty', exchange, usage: spent, documents: [], startId };
    }
    const parts = result.resultValue as ReviewReportResult;
    const round = opinions.map((opinion) => ({
      name: opinion.kind.slice(REVIEWS.prefix.length),
      result: opinion.result,
    }));
    const text = await deps.runReport.renderParts(opened.run, parts, round);
    return { documents: reportDocuments(text, parts), exchange, usage: spent, startId };
  } catch (error) {
    if (
      error instanceof RuntimeLimit ||
      error instanceof HostUnavailable ||
      error instanceof StartRefused ||
      error instanceof StepStopped
    ) {
      throw error;
    }
    const message = reportFailure('code-review', error).message;
    return {
      error: message,
      exchange: null,
      usage: empty,
      documents: error instanceof ResultInvalid ? [answerErrorsDocument(error.errors)] : [],
      startId,
    };
  }
}

/** One reviewer visit, with its own chart and exchange, the same shape as any other step. */
export async function recordAngle(deps: ReviewDeps, opened: OpenedStep, item: Finished): Promise<void> {
  const result = item.result;
  if (!result) {
    return;
  }
  const parsed = item.parsed;
  const status = item.outage
    ? HOST_VISIT.status
    : item.error
      ? 'failed'
      : item.asked || parsed?.decision === 'return'
        ? 'waiting'
        : parsed
          ? 'done'
          : 'failed';
  const broken = item.error !== undefined && !item.outage;
  const exchange = exchangeOf(item);
  const stat = await deps.visits.finishVisit(opened.run, {
    step: `code-review-${item.reviewer.name}`,
    runtime: item.runtime,
    model: item.model,
    ...effortFields(item),
    mode: 'ask',
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    status,
    exitCode: broken ? 1 : 0,
    killReason: item.outage ? HOST_VISIT.killReason : result.killReason ? visitKillReason(result.killReason) : null,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    usd: result.usd,
    samples: result.samples,
    exchange,
    httpCalls: [],
    document: null,
    documents: [
      ...(parsed ? reviewDocuments(parsed) : []),
      ...(broken ? [{ kind: ARTIFACTS.error.kind, fileName: '', body: `${item.error}\n` }] : []),
      ...(item.answerErrors ? [answerErrorsDocument(item.answerErrors)] : []),
    ],
    resumed: result.resumed,
  });
  if (item.startId) await deps.door.linkVisit(item.startId, stat.id);
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
    text = mergeHandoff(text, step, summaryNote(opinion.result));
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
    .map((document) => {
      const name = document.kind.slice(REVIEWS.prefix.length);
      return `${name}: ${storedReview(name, documents)?.decision ?? 'none'}`;
    });
  return ctx.end({
    outcome,
    ...(decisions.length > 0 ? { facts: { details: decisions } } : {}),
    exitCode,
    line,
    moveTo,
    ...(route.to === 'wait' ? { code: route.code, limit: route.limit, retryAt: route.retryAt } : {}),
    ...(route.to === 'block' ? { code: route.code } : {}),
    visit: {
      step: 'code-review',
      runtime: exchanges.find((exchange) => exchange.runtime)?.runtime ?? null,
      model: exchanges.find((exchange) => exchange.model)?.model ?? null,
      ...effortFields(exchanges.find((exchange) => exchange.effort) ?? {}),
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
  return { runtime: item.runtime, ...effortFields(item), ...agentExchange(result, item.model, item.prompt) };
}
