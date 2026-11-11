import type { AgentRunResult } from '../../agent/agent-runner';
import type { DocumentDraft, SampleDraft, VisitDraft } from '../../history/visit';
import type { OpenedStep } from '../../steps/step-run';
import type { StepName } from '../../contract/steps';
import type { HttpCallDraft } from '../../core/swarmloop-error';

export function modelVisit(input: {
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
}): VisitDraft {
  const now = new Date(input.now).toISOString();
  const agent = input.agent;
  const wallStart = input.opened.run.stepStartedAt ?? input.opened.startedAt ?? now;
  const startedMs = Date.parse(wallStart);
  const documents = [...(input.document ? [input.document] : []), ...(input.documents ?? [])];
  return {
    step: input.step,
    runtime: input.runtime,
    model: input.model,
    mode: input.mode,
    startedAt: wallStart,
    finishedAt: now,
    durationMs: Number.isFinite(startedMs) ? Math.max(0, input.now - startedMs) : 0,
    status: input.status,
    exitCode: input.exitCode,
    killReason: agent?.killReason ? `process killed: ${agent.killReason}` : null,
    tokensIn: agent?.tokensIn ?? 0,
    tokensOut: agent?.tokensOut ?? 0,
    usd: agent?.usd ?? 0,
    samples: [...(input.samples ?? []), ...(agent?.samples ?? [])],
    exchange: agent
      ? {
          model: input.model,
          startedAt: agent.startedAt,
          finishedAt: agent.finishedAt,
          durationMs: agent.durationMs,
          requestText: input.prompt,
          responseText: agent.responseText,
          chatId: agent.chatId,
          resumed: agent.resumed,
          killReason: agent.killReason,
        }
      : null,
    httpCalls: input.httpCalls ?? [],
    document: null,
    documents: documents.length > 0 ? documents : undefined,
    resumed: agent?.resumed ?? false,
  };
}
