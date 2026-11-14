import type { AppConfig } from '../../config/env';
import { agentFor } from '../../config/agents';
import { resolveRepoRoot } from '../../config/repo-root';
import { chargeStream } from '../../agent/spend';
import type { Charge } from '../../agent/spend';
import { loadPriceTable } from '../../agent/prices';
import { logStillOpen } from '../../agent/live-output';
import { stepOutput } from '../../core/attempt-output';
import type { Clock } from '../../core/clock';
import type { StepView, VisitView } from '../../contract/api';
import type { LiveSample } from '../../contract/live';
import { visitKey } from '../../contract/visit-key';
import type { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import { root } from '../../history/run-paths';
import type { DocumentRepository } from '../../history/document.repository';
import type { RunRepository } from '../../history/run.repository';
import type { VisitRepository } from '../../history/visit.repository';
import type { LiveHub } from '../../live/live.hub';
import { requireReviewer } from '../../contract/steps';
import { reviewLogDecision } from '../../contract/readable-log-review';
import { storedReview } from '../../agent-result/stored-review';
import { requireRun } from '../run-queries-run';
import type { stepMeta } from '../run-queries-run';
import { visitLogSize } from '../run-queries-log';
import { decisionStatus, hasOutput, reviewerOutcome, roundLog } from './chips';
import { belongsToVisit, documentView, legacyLogs } from './documents';
import { effortOf, exchangesOf, samplesOf } from './visit-parts';

/** What the reviewer steps read of the service that builds them. */
interface ReviewerStepDeps {
  runs: RunRepository;
  documents: DocumentRepository;
  visits: VisitRepository;
  config: AppConfig;
  clock: Clock;
  live?: Pick<LiveHub, 'samplesOf'>;
  /** True while the code-review step runs, so its reviewers write the run's active attempt. */
  reviewRunning: (run: RunEntity) => boolean;
  runningVisit: (run: RunEntity, name: string, previousAttempt: number, samples?: LiveSample[]) => VisitView;
  meta: (run: RunEntity, name: string) => ReturnType<typeof stepMeta>;
}

const reviewKind = (name: string): string => `review_${name.slice('code-review-'.length)}`;

/** The step view of one reviewer of code review. */
export class ReviewerSteps {
  constructor(private readonly deps: ReviewerStepDeps) {}

  async step(key: string, name: string): Promise<StepView> {
    const { runs, documents: documentRepository, visits: visitRepository, config, clock, live } = this.deps;
    const run = await requireRun(runs, key);
    const documents = await documentRepository.listDocuments(run.id);
    const own = (await visitRepository.listStats(run.id)).filter((stat) => stat.step === name);
    if (own.length > 0) {
      return this.angleStep(run, name, documents, own);
    }
    const stats = (await visitRepository.listStats(run.id)).filter((stat) => stat.step === 'code-review');
    const samples = await visitRepository.listSamples(stats.map((stat) => stat.id));
    const kind = reviewKind(name);
    const parentRunning = this.deps.reviewRunning(run);
    const ownedStats = stats.filter((stat) =>
      documents.some((document) => document.stepStatId === stat.id && document.kind === kind),
    );
    const attempt = parentRunning ? run.activeAttempt : (ownedStats.at(-1)?.attemptId ?? null);
    const raw = parentRunning ? roundLog(root(config), run, name) : stepOutput(root(config), key, name, attempt);
    const env = config.env;
    const agent = agentFor(env, run, name);
    const model = agent?.model ?? null;
    let charge: Charge | null = null;
    if (agent && hasOutput(raw)) {
      charge = chargeStream(
        agent.model,
        raw,
        await loadPriceTable(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), agent.runtime, clock.now()),
      );
    }
    const visits: VisitView[] = ownedStats.map((stat, index) => {
      const latestDone = index === ownedStats.length - 1 && !parentRunning;
      const owned = documents.filter((document) => document.stepStatId === stat.id && document.kind === kind);
      const log = latestDone ? raw : '';
      const verdict =
        reviewLogDecision(log) ??
        storedReview(
          requireReviewer(name),
          documents.filter((document) => document.stepStatId === stat.id),
        )?.decision ??
        null;
      return {
        id: stat.id,
        key: visitKey(stat.id),
        attempt: index + 1,
        status: decisionStatus(verdict, stat.status),
        model,
        ...effortOf(stat),
        mode: 'agent' as const,
        durationMs: stat.durationMs,
        tokensIn: latestDone ? (charge?.tokensIn ?? 0) : 0,
        tokensOut: latestDone ? (charge?.tokensOut ?? 0) : 0,
        usd: latestDone ? (charge?.usd ?? 0) : 0,
        cpuAvg: stat.cpuAvg,
        cpuPeak: stat.cpuPeak,
        memAvg: stat.memAvg,
        memPeak: stat.memPeak,
        killReason: stat.killReason,
        decision: verdict ? `decision: ${verdict}` : null,
        ...visitLogSize(config, run, name, stat, documents),
        documents: [...owned, ...legacyLogs(documents, stat)].map(documentView),
        exchanges: [],
        samples: samplesOf(samples, stat.id),
      };
    });
    if (parentRunning && hasOutput(raw)) {
      visits.push({
        ...this.deps.runningVisit(run, name, visits.length, live?.samplesOf(run.key, name)),
        model,
        mode: 'agent',
        status: logStillOpen(raw) ? 'running' : reviewerOutcome(raw, 'failed'),
        ...(charge ? { tokensIn: charge.tokensIn, tokensOut: charge.tokensOut, usd: charge.usd } : {}),
      });
    }
    return { step: name, ...(await this.deps.meta(run, name)), visits, checks: [] };
  }

  /** A reviewer visit is the same record as any other step: its own log, exchange, and chart. */
  private async angleStep(
    run: RunEntity,
    name: string,
    documents: DocumentEntity[],
    stats: StepStatEntity[],
  ): Promise<StepView> {
    const { visits: visitRepository, config, live } = this.deps;
    const kind = reviewKind(name);
    const kinds = [kind, 'error'];
    const exchanges = await visitRepository.listExchanges(stats.map((stat) => stat.id));
    const samples = await visitRepository.listSamples(stats.map((stat) => stat.id));
    const parentRunning = this.deps.reviewRunning(run);
    const visits = stats.map((stat, index) => {
      const verdict =
        storedReview(
          requireReviewer(name),
          documents.filter((document) => document.stepStatId === stat.id),
        )?.decision ?? null;
      return {
        id: stat.id,
        key: visitKey(stat.id),
        attempt: stat.attempt,
        status: decisionStatus(verdict, stat.status),
        model: stat.model,
        ...effortOf(stat),
        mode: stat.mode,
        durationMs: stat.durationMs,
        tokensIn: stat.tokensIn,
        tokensOut: stat.tokensOut,
        usd: stat.usd,
        cpuAvg: stat.cpuAvg,
        cpuPeak: stat.cpuPeak,
        memAvg: stat.memAvg,
        memPeak: stat.memPeak,
        killReason: stat.killReason,
        decision: verdict ? `decision: ${verdict}` : null,
        ...visitLogSize(config, run, name, stat, documents, {
          latest: index === stats.length - 1,
          reviewRunning: parentRunning,
        }),
        documents: [
          ...documents.filter((document) => belongsToVisit(document, stat.id, kinds, index === stats.length - 1)),
          ...legacyLogs(documents, stat),
        ].map(documentView),
        exchanges: exchangesOf(exchanges, stat.id),
        samples: samplesOf(samples, stat.id),
      };
    });
    if (parentRunning && logStillOpen(roundLog(root(config), run, name))) {
      visits.push(this.deps.runningVisit(run, name, stats.at(-1)?.attempt ?? 0, live?.samplesOf(run.key, name)));
    }
    return { step: name, ...(await this.deps.meta(run, name)), visits, checks: [] };
  }
}
