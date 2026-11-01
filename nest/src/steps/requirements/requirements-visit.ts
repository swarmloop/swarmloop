import { SampleDraft, VisitDraft } from '../../history/visit';
import { KillReason } from '../../limits/limits';
import { RequirementsWrite } from '../../integrations/requirements-source/requirements-source';
import { HttpCallDraft } from '../../swarmloop-error';

export interface RequirementsFinish {
  written: RequirementsWrite;
  calls: HttpCallDraft[];
  outcome: 'ok' | 'failed' | 'blocked' | 'waiting';
  exitCode: number;
  message: string;
  body: string | null;
  kind?: string;
}

export function requirementsVisit(samples: SampleDraft[], input: RequirementsFinish): Partial<VisitDraft> {
  return {
    model: input.written.exchange?.model ?? null,
    mode: input.written.exchange ? 'agent' : null,
    exitCode: input.exitCode,
    killReason: input.written.killReason,
    tokensIn: input.written.tokensIn,
    tokensOut: input.written.tokensOut,
    usd: input.written.usd,
    samples,
    exchange: input.written.exchange,
    httpCalls: input.calls,
    ...visitDocuments(input),
    resumed: input.written.resumed,
  };
}

/** An ok visit keeps its record in `documents`, where the handoff note is added after it. */
function visitDocuments(input: RequirementsFinish): Partial<Pick<VisitDraft, 'document' | 'documents'>> {
  const document = input.body ? { kind: input.kind ?? 'requirements', fileName: '', body: input.body } : null;
  if (input.outcome === 'ok') {
    return { document: null, documents: document ? [document] : [] };
  }
  return { document };
}

export function stopReason(
  key: string,
  written: RequirementsWrite,
): Pick<RequirementsFinish, 'outcome' | 'message'> | null {
  if (ceiling(written.killReason)) {
    return { outcome: 'blocked', message: `${key} blocked: ${written.killReason}` };
  }
  if (written.killReason === 'time' || written.killReason === 'idle') {
    return { outcome: 'failed', message: `${key} requirements killed: ${written.killReason}` };
  }
  if (!written.body.trim()) {
    return { outcome: 'failed', message: 'requirements record is empty' };
  }
  return null;
}

export function emptyWrite(): RequirementsWrite {
  return {
    body: '',
    calls: 0,
    usd: 0,
    tokensIn: 0,
    tokensOut: 0,
    exchange: null,
    killReason: null,
    samples: [],
    resumed: false,
  };
}

function ceiling(reason: KillReason | null): boolean {
  return reason === 'usd' || reason === 'tokens' || reason === 'calls';
}
