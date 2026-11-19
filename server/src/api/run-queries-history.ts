import type { HistoryView } from '../contract/api';
import type { AppConfig } from '../config/env';
import type { DocumentRepository } from '../history/document.repository';
import type { EventRepository } from '../history/event.repository';
import type { FlowRepository } from '../history/flow.repository';
import type { RunRepository } from '../history/run.repository';
import type { VisitRepository } from '../history/visit.repository';
import { documentView, filesOf, withoutServerRecords } from './run-view/documents';
import { launchView, loopView } from './run-view/live';
import { requireRun } from './run-queries-run';
import { outputsOf, visitLogSize } from './run-queries-log';

interface HistorySources {
  runs: RunRepository;
  documents: DocumentRepository;
  visits: VisitRepository;
  events: EventRepository;
  flows: FlowRepository;
  config: AppConfig;
}

/** The history of a run: its launches, documents, exchanges, loops, HTTP calls, samples and visit stats. `reviewRunning` tells whether its code-review reviewers write the active attempt. */
export async function readHistory(
  sources: HistorySources,
  key: string,
  reviewRunning: (run: Awaited<ReturnType<typeof requireRun>>) => boolean,
): Promise<HistoryView> {
  const { runs, documents: documentRepository, visits, events, flows, config } = sources;
  const run = await requireRun(runs, key);
  const documents = withoutServerRecords(await documentRepository.listDocuments(run.id));
  const stats = await visits.listStats(run.id);
  const exchanges = await visits.listExchanges(stats.map((stat) => stat.id));
  const samples = await visits.listSamples(stats.map((stat) => stat.id));
  const loops = await events.listLoops(run.id);
  const calls = await events.listHttpCalls(run.id);
  const launches = await flows.listFlows(run.id);
  const reviewing = reviewRunning(run);
  const newestReviewerFile =
    !reviewing && stats.some((stat) => !stat.attemptId && stat.step.startsWith('code-review-'));
  const outputs = await outputsOf(config, run, stats, newestReviewerFile);
  return {
    launches: launches.map(launchView),
    documents: documents.filter((document) => document.kind !== 'log').map(documentView),
    files: filesOf(documents),
    exchanges: exchanges.map((exchange) => ({
      stepStatId: exchange.stepStatId,
      model: exchange.model,
      durationMs: exchange.durationMs,
      request: exchange.requestText,
      response: exchange.responseText,
    })),
    loops: loops.map(loopView),
    calls: calls.map((call) => ({
      method: call.method,
      url: call.url,
      statusCode: call.statusCode,
      durationMs: call.durationMs,
      error: call.error,
    })),
    samples: samples.map((sample) => ({
      stepStatId: sample.stepStatId,
      at: sample.sampledAt,
      cpu: sample.cpuPercent,
      memory: sample.rssBytes,
      source: sample.source ?? 'agent',
    })),
    stats: stats.map((stat) => ({
      ...visitLogSize(outputs, run, stat.step, stat, {
        latest: stats.filter((item) => item.step === stat.step).at(-1) === stat,
        reviewRunning: reviewing,
      }),
      id: stat.id,
      step: stat.step,
      attempt: stat.attempt,
      model: stat.model,
      durationMs: stat.durationMs,
      usd: stat.usd,
      tokensIn: stat.tokensIn,
      tokensOut: stat.tokensOut,
      cpuPeak: stat.cpuPeak,
      memPeak: stat.memPeak,
    })),
  };
}
