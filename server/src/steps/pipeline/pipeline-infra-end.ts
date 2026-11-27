import type { HttpCallDraft } from '../../core/swarmloop-error';
import type { CodeHost } from '../../integrations/code-host/code-host';
import { CI_INFRA_SOURCE, issueOf } from '../shared/handoff';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepResult } from '../contract/step-contract';
import type { OpenedStep } from '../step-run';
import { readNotes } from './ci-host';
import { blockedEnd } from './pipeline-result';
import { report } from './pipeline-red';
import { renderInfra, type InfraCode, type RunRow, type Seen } from './pipeline-report';

/** What was tried before a person is asked: the wait for a run that never started, or the reruns that ended the same way. */
function triedLine(unstarted: boolean, reruns: number, notes: string, startTimeoutMs: number): string {
  if (unstarted) {
    const minutes = Math.round(startTimeoutMs / 60000);
    return `tried: waited ${minutes} minutes for the host to start the run${notes ? `; the host says: ${notes}` : ''}\n`;
  }
  return reruns > 0 ? `tried: ${reruns} reruns of the failed jobs\n` : '';
}

/** What the end of an infra route reads: the run, the host, what was seen and what the reruns said. */
interface InfraEnd {
  opened: OpenedStep;
  calls: HttpCallDraft[];
  host: CodeHost;
  code: InfraCode;
  seen: Seen[];
  unstarted: RunRow[];
  finished: RunRow[];
  reruns: number;
  errors: string[];
  startTimeoutMs: number;
}

/** The run blocks and asks a person: the notes of the host, what was tried and the issue for the handoff. */
export async function infraBlockedEnd(input: InfraEnd): Promise<StepResult> {
  const { opened, calls, host, code, seen, unstarted, finished, reruns, errors } = input;
  const notes = await readNotes(host, unstarted.length > 0 ? unstarted : finished, calls);
  const tried = triedLine(unstarted.length > 0, reruns, notes, input.startTimeoutMs);
  const body = `${renderInfra(code, seen, notes)}${tried}${errors.map((error) => `rerun: ${error}\n`).join('')}`;
  const result = blockedEnd(
    report(opened, code === 'CI_TIMEOUT' ? 'CI timed out' : 'CI did not run', body),
    code,
    body,
  );
  const issue = issueOf(CI_INFRA_SOURCE, code, body);
  return { ...result, outputs: [...result.outputs, { artifact: ARTIFACTS.issues, value: [issue] }] };
}
