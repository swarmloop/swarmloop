import type { SampleDraft, VisitDraft } from '../../history/visit';
import type { KillReason } from '../../core/kill-reason';
import type { RequirementsWrite } from '../../integrations/requirements-source/requirements-source';
import type { HttpCallDraft } from '../../core/swarmloop-error';
import type { Artifact } from '../contract/artifact';
import { ARTIFACTS } from '../contract/artifacts';
import type { ArtifactValue } from '../contract/step-contract';

export interface RequirementsFinish {
  written: RequirementsWrite;
  calls: HttpCallDraft[];
  outcome: 'ok' | 'failed' | 'blocked' | 'waiting';
  exitCode: number;
  message: string;
  body: string | null;
  /** What `body` is stored as. The requirements record unless this says otherwise. */
  artifact?: Artifact<string>;
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
    resumed: input.written.resumed,
  };
}

export function requirementsOutputs(input: RequirementsFinish): ArtifactValue[] {
  return input.body ? [{ artifact: input.artifact ?? ARTIFACTS.requirements, value: input.body }] : [];
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
