import { reviewChipStatus, usageFromLog } from './readable-log.ts';
import type { StepView } from './types.ts';

export interface LiveUsage {
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

export function fileView(step: string, body: string): StepView {
  const done = reviewChipStatus(body);
  return {
    step,
    checks: [],
    visits: [
      {
        id: -1,
        attempt: 1,
        status: done ?? 'running',
        model: null,
        mode: 'agent',
        durationMs: 0,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        cpuAvg: 0,
        cpuPeak: 0,
        memAvg: 0,
        memPeak: 0,
        killReason: null,
        decision: null,
        documents: [{ kind: 'log', attempt: 1, body: body || 'waiting for output\n', createdAt: new Date().toISOString() }],
        exchanges: [],
        samples: [],
      },
    ],
  };
}

export function withFileUsage(view: StepView): StepView {
  const visit = view.visits.at(-1);
  const log = visit?.documents.find((item) => item.kind === 'log')?.body;
  if (!visit || !log) {
    return view;
  }
  const reported = visit.tokensIn > 0 || visit.tokensOut > 0 || visit.usd > 0 ? { tokensIn: visit.tokensIn, tokensOut: visit.tokensOut, usd: visit.usd } : undefined;
  if (visit.status === 'running') {
    return withLog(view, log, visit.samples, reported);
  }
  const parsed = tokenUsage(log, reported);
  if (Object.keys(parsed).length === 0) {
    return view;
  }
  const visits = view.visits.slice();
  visits[visits.length - 1] = { ...visit, ...parsed };
  return { ...view, visits };
}

export function withLog(view: StepView, body: string, samples: StepView['visits'][number]['samples'], reported?: LiveUsage): StepView {
  const index = view.visits.length - 1;
  const visit = view.visits[index];
  if (!visit) {
    return view;
  }
  if (visit.status !== 'running') {
    if (reviewChipStatus(body)) {
      if (samples.length === 0 || visit.samples.length > 0) {
        return view;
      }
      const visits = view.visits.slice();
      visits[index] = { ...visit, samples, ...usage(samples), ...tokenUsage(body, reported) };
      return { ...view, visits };
    }
    const attempt = visit.attempt + 1;
    const counted = tokenUsage(body, reported);
    const opened: StepView['visits'][number] = {
      ...visit,
      id: -1,
      attempt,
      status: reviewChipStatus(body) ?? 'running',
      durationMs: 0,
      killReason: null,
      decision: null,
      documents: [{ kind: 'log', attempt, body, createdAt: new Date().toISOString() }],
      exchanges: [],
      samples,
      ...usage(samples),
      ...counted,
    };
    if (!('tokensIn' in counted)) {
      opened.tokensIn = 0;
      opened.tokensOut = 0;
      opened.usd = 0;
    }
    return { ...view, visits: [...view.visits, opened] };
  }
  const documents = visit.documents.some((item) => item.kind === 'log')
    ? visit.documents.map((item) => (item.kind === 'log' ? { ...item, body } : item))
    : [...visit.documents, { kind: 'log', attempt: visit.attempt, body, createdAt: new Date().toISOString() }];
  const visits = view.visits.slice();
  visits[index] = {
    ...visit,
    documents,
    samples,
    status: visit.decision === 'decision: ok' && reviewChipStatus(body) === 'waiting' ? 'done' : (reviewChipStatus(body) ?? visit.status),
    ...usage(samples),
    ...tokenUsage(body, reported),
  };
  return { ...view, visits };
}

export function visitChecks(visit: StepView['visits'][number] | undefined): StepView['checks'] {
  if (!visit) {
    return [];
  }
  return visit.documents
    .filter((item) => item.kind.startsWith('review_') && item.kind !== 'review_report' && item.kind !== 'review_residual')
    .map((item) => ({ name: item.kind.slice('review_'.length), decision: decisionLine(item.body), body: item.body }));
}

export function reportAgrees(body: string | undefined, decision: string | null | undefined): boolean {
  if (!body) {
    return false;
  }
  const line = decisionLine(body);
  if (!line || !decision) {
    return true;
  }
  return line === decision;
}

export function decisionLine(body: string): string | null {
  return (
    body
      .split('\n')
      .map((item) => item.trim())
      .filter((item) => item.startsWith('decision:'))
      .pop() ?? null
  );
}

export function shownStatus(status: string, latest: boolean, runStatus?: string, step?: string, decision?: string | null): string {
  if (step?.startsWith('code-review') && status !== 'running') {
    if (decision === 'decision: ok') {
      return 'done';
    }
    if (decision === 'decision: return') {
      return 'waiting';
    }
  }
  if (step?.startsWith('code-review-') && (status === 'waiting' || status === 'failed')) {
    return status;
  }
  if (status === 'waiting' && !(latest && runStatus === 'waiting')) {
    return 'done';
  }
  return status;
}

export function tokenUsage(body: string, reported?: LiveUsage): { tokensIn: number; tokensOut: number; usd: number } | Record<string, never> {
  const parsed = usageFromLog(body);
  const tokensIn = reported && reported.tokensIn > 0 ? reported.tokensIn : (parsed?.tokensIn ?? reported?.tokensIn);
  const tokensOut = reported && reported.tokensOut > 0 ? reported.tokensOut : (parsed?.tokensOut ?? reported?.tokensOut);
  if (tokensIn === undefined || tokensOut === undefined) {
    return {};
  }
  const usd = reported?.usd ?? 0;
  return { tokensIn, tokensOut, usd };
}

export function usage(samples: { cpu: number; memory: number }[]): { cpuAvg: number; cpuPeak: number; memAvg: number; memPeak: number } {
  if (samples.length === 0) {
    return { cpuAvg: 0, cpuPeak: 0, memAvg: 0, memPeak: 0 };
  }
  const cpu = samples.map((sample) => sample.cpu);
  const memoryBytes = samples.map((sample) => sample.memory);
  const avg = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    cpuAvg: avg(cpu),
    cpuPeak: Math.max(...cpu),
    memAvg: Math.round(avg(memoryBytes)),
    memPeak: Math.max(...memoryBytes),
  };
}

export function stepText(
  step: string,
  visit: StepView['visits'][number] | undefined,
  selected: { body: string } | undefined,
  checks: { body: string }[],
): { logs: string; document: string } {
  const logs = selected ? '' : (visit?.documents.filter((item) => item.kind === 'log').map((item) => item.body).join('\n') ?? '');
  const storedReport = step === 'code-review' ? visit?.documents.find((item) => item.kind === 'review_report')?.body : undefined;
  const report = reportAgrees(storedReport, visit?.decision) ? storedReport : undefined;
  const angleNotes = checks.map((item) => item.body).filter(Boolean);
  const document =
    selected?.body ??
      (report ||
      (angleNotes.length > 0 ? angleNotes.join('\n\n') : '') ||
      visit?.documents
        .filter((item) => item.kind !== 'log' && item.kind !== 'review_report')
        .map((item) => item.body)
        .filter(Boolean)
        .join('\n\n') ||
      '');
  return { logs, document };
}
