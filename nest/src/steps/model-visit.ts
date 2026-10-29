import { AgentRunResult } from '../limits/agent-runner';
import { DocumentDraft, VisitDraft } from '../history/visit';
import { OpenedStep } from '../pipeline/step-run';
import { StepName } from '../pipeline/pipeline-result';
import { HttpCallDraft } from '../swarmloop-error';

export function modelVisit(input: {
  opened: OpenedStep;
  step: StepName;
  mode: string;
  model: string;
  agent: AgentRunResult | null;
  prompt: string;
  status: string;
  exitCode: number;
  document?: DocumentDraft;
  documents?: DocumentDraft[];
  httpCalls?: HttpCallDraft[];
}): VisitDraft {
  const now = new Date().toISOString();
  const agent = input.agent;
  const wallStart = input.opened.run.stepStartedAt ?? input.opened.startedAt ?? now;
  const startedMs = Date.parse(wallStart);
  const documents = [
    ...(input.document ? [input.document] : []),
    ...(input.documents ?? []),
    ...(agent?.output ? [{ kind: 'log', fileName: '', body: agent.output.endsWith('\n') ? agent.output : `${agent.output}\n` }] : []),
  ];
  return {
    step: input.step,
    model: input.model,
    mode: input.mode,
    startedAt: wallStart,
    finishedAt: now,
    durationMs: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0,
    status: input.status,
    exitCode: input.exitCode,
    killReason: agent?.killReason ? `process killed: ${agent.killReason}` : null,
    tokensIn: agent?.tokensIn ?? 0,
    tokensOut: agent?.tokensOut ?? 0,
    usd: agent?.usd ?? 0,
    samples: agent?.samples ?? [],
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
