import type { AgentRunResult } from '../../agent/agent-runner';
import { countShellEdits } from '../../agent/shell-edits';
import type { DocumentDraft, ExchangeDraft, SampleDraft, VisitDraft } from '../../history/visit';
import type { OpenedStep } from '../../steps/step-run';
import type { StepName } from '../../contract/steps';
import { effortFields } from '../../contract/effort';
import type { EffortFields } from '../../contract/effort';
import type { HttpCallDraft } from '../../core/swarmloop-error';

/** The one exchange of an agent's launch: what it was asked, what it answered and how the chat went. */
export function agentExchange(agent: AgentRunResult, model: string, prompt: string): ExchangeDraft {
  return {
    model,
    startedAt: agent.startedAt,
    finishedAt: agent.finishedAt,
    durationMs: agent.durationMs,
    requestText: prompt,
    responseText: agent.responseText,
    chatId: agent.chatId,
    resumed: agent.resumed,
    killReason: agent.killReason,
  };
}

/** What the agent's result adds to a visit: its end, its spend and the one exchange. A step that ran no agent adds none. */
function agentPart(
  agent: AgentRunResult | null,
  model: string,
  prompt: string,
): Pick<VisitDraft, 'killReason' | 'tokensIn' | 'tokensOut' | 'usd' | 'exchange' | 'resumed' | 'shellEdits'> {
  return {
    killReason: agent?.killReason ? `process killed: ${agent.killReason}` : null,
    tokensIn: agent?.tokensIn ?? 0,
    tokensOut: agent?.tokensOut ?? 0,
    usd: agent?.usd ?? 0,
    exchange: agent ? agentExchange(agent, model, prompt) : null,
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
    /** Samples of the step's other containers; the agent's come with `agent`. */
    samples?: SampleDraft[];
    prompt: string;
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
    ...agentPart(agent, input.model, input.prompt),
    samples: [...(input.samples ?? []), ...(agent?.samples ?? [])],
    httpCalls: input.httpCalls ?? [],
    document: null,
    documents: documents.length > 0 ? documents : undefined,
  };
}
