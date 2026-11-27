import type { VisitView } from '../../contract/api';
import { visitKey } from '../../contract/visit-key';
import type { OutputFiles } from '../../core/attempt-output';
import type {
  AgentExchangeEntity,
  DocumentEntity,
  ResourceSampleEntity,
  RunEntity,
  StepStatEntity,
} from '../../history/entities';
import { visitLogSize } from '../run-queries-log';
import { angleVerdict, decisionLine, decisionStatus } from './chips';
import { belongsToVisit, documentView, interruptionOf } from './documents';
import { effortOf, exchangesOf, samplesOf } from './visit-parts';

/** What a step's stored visits are built from. */
interface StoredVisitSources {
  run: RunEntity;
  name: string;
  /** The stats of this step only, oldest first. */
  stats: StepStatEntity[];
  documents: DocumentEntity[];
  exchanges: AgentExchangeEntity[];
  samples: ResourceSampleEntity[];
  outputs: OutputFiles;
  /** The kinds of document a visit of this step shows. */
  kinds: string[];
}

/** One view per stored visit of a step: its documents, verdict, interruption, log size, exchanges and samples. */
export function storedVisits({
  run,
  name,
  stats,
  documents,
  exchanges,
  samples,
  outputs,
  kinds,
}: StoredVisitSources): VisitView[] {
  return stats.map((stat, index) => {
    const owned = documents.filter((document) => document.stepStatId === stat.id);
    const verdict = name === 'code-review' ? angleVerdict(owned) : null;
    const interruption = interruptionOf(owned, stat.id);
    return {
      id: stat.id,
      key: visitKey(stat.id),
      attempt: stat.attempt,
      status: decisionStatus(verdict, stat.status),
      model: stat.model,
      ...effortOf(stat),
      mode: stat.mode,
      durationMs: stat.durationMs,
      preparedMs: stat.preparedMs,
      tokensIn: stat.tokensIn,
      tokensOut: stat.tokensOut,
      usd: stat.usd,
      cpuAvg: stat.cpuAvg,
      cpuPeak: stat.cpuPeak,
      memAvg: stat.memAvg,
      memPeak: stat.memPeak,
      killReason: stat.killReason,
      ...(interruption ? { interruption } : {}),
      decision: verdict ? `decision: ${verdict}` : decisionLine(owned.map((document) => document.body).join('\n')),
      ...visitLogSize(outputs, run, name, stat),
      documents: documents
        .filter((document) => belongsToVisit(document, stat.id, kinds, index === stats.length - 1))
        .map(documentView),
      exchanges: exchangesOf(exchanges, stat.id),
      samples: samplesOf(samples, stat.id),
    };
  });
}
