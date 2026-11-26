import { countShellEdits } from '../../agent/shell-edits';
import type { DocumentDraft, SampleDraft, VisitDraft } from '../../history/visit';
import type { OpenedStep } from '../../steps/step-run';
import type { StepName } from '../../contract/steps';
import { effortFields } from '../../contract/effort';
import type { EffortFields } from '../../contract/effort';
import type { KillReason } from '../../core/kill-reason';
import type { HttpCallDraft } from '../../core/swarmloop-error';
import type { AgentRunResult } from '../../agent/agent-runner';

/** How a visit killed by its agent's own limit is stored. */
export function visitKillReason(reason: KillReason): string {
  return `process killed: ${reason}`;
}

/** What the agent's result adds to a visit: its end and its spend. A step that ran no agent adds none. */
function agentPart(
  agent: AgentRunResult | null,
): Pick<VisitDraft, 'killReason' | 'tokensIn' | 'tokensOut' | 'usd' | 'resumed' | 'shellEdits'> {
  return {
    killReason: agent?.killReason ? visitKillReason(agent.killReason) : null,
    tokensIn: agent?.tokensIn ?? 0,
    tokensOut: agent?.tokensOut ?? 0,
    usd: agent?.usd ?? 0,
    resumed: agent?.resumed ?? false,
    shellEdits: countShellEdits(agent?.output),
  };
}

function wallDuration(nowMs: number, startedAt: string): number {
  const startedMs = Date.parse(startedAt);
  return Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0;
}

export function modelVisit(
  input: EffortFields & {
    opened: OpenedStep;
    now: number;
    step: StepName;
    mode: string;
    runtime: string;
    model: string;
    agent: AgentRunResult | null;
    /** The rows of the call log that the visit's launches wrote. */
    callIds?: number[];
    /** Samples of the step's other containers; the agent's come with `agent`. */
    samples?: SampleDraft[];
    status: string;
    exitCode: number;
    document?: DocumentDraft;
    documents?: DocumentDraft[];
    httpCalls?: HttpCallDraft[];
  },
): VisitDraft {
  const now = new Date(input.now).toISOString();
  const agent = input.agent;
  const wallStart = input.opened.run.stepStartedAt ?? input.opened.startedAt ?? now;
  const documents = [...(input.document ? [input.document] : []), ...(input.documents ?? [])];
  return {
    step: input.step,
    runtime: input.runtime,
    model: input.model,
    ...effortFields(input),
    mode: input.mode,
    startedAt: wallStart,
    finishedAt: now,
    durationMs: wallDuration(input.now, wallStart),
    status: input.status,
    exitCode: input.exitCode,
    ...agentPart(agent),
    callIds: input.callIds,
    samples: [...(input.samples ?? []), ...(agent?.samples ?? [])],
    httpCalls: input.httpCalls ?? [],
    document: null,
    documents: documents.length > 0 ? documents : undefined,
  };
}
