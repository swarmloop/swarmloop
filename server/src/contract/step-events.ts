import type { StepName } from './steps';

/** What every event carries. `runId` is the numeric id of the run. */
interface StepEventBase {
  payloadVersion: 1;
  eventId: string;
  runId: number;
  attemptId: string;
  step: StepName;
  seq: number;
  occurredAt: string;
  parentSpanId: string | null;
}

interface CommandStart {
  spanId: string;
  actor: 'server' | 'agent';
  repo: string;
  /** Relative to the root of the server. */
  cwd: string;
  executable: string;
  args: string[];
}

interface CommandEnd {
  spanId: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  /** The last lines of the output, redacted. Null when there is none to show. */
  output: string | null;
}

interface AgentProfileSummary {
  runtime: string;
  model: string;
  mode: string;
  timeLimitMs: number;
  session: 'resume' | 'fresh';
}

interface AgentLaunch {
  runtime: string;
  model: string;
  chatId: string | null;
  resumed: boolean;
}

/** `reason` is null when the chat goes on. */
interface SessionChange {
  session: 'same chat' | 'new chat';
  runtime: string;
  model: string;
  reason: 'runtime changed' | 'no stored chat' | 'fresh by step policy' | 'replay' | 'chat state removed' | null;
}

/** What an attempt did, beyond its result line. */
export interface AttemptFacts {
  /** The checks result, a reviewer's decision, the merge request URL or the job results, one per line. */
  details?: string[];
}

/** The part of an event that depends on its kind. */
export type StepEventBody =
  | {
      kind: 'input.received';
      name: string;
      inputKind: string;
      documentId: number | 'absent';
      summary: string;
      meta?: string;
    }
  | {
      kind: 'agent.tool';
      tool: string;
      target: string;
      status: 'ok' | 'failed' | 'unfinished';
      durationMs: number;
      resultLine: string;
    }
  | { kind: 'agent.message'; text: string; chars: number }
  | { kind: 'host.suspended'; durationMs: number }
  | { kind: 'activity.started'; spanId: string; title: string }
  | {
      kind: 'activity.finished';
      spanId: string;
      title: string;
      result: string;
      failed: boolean;
      durationMs: number;
    }
  | { kind: 'attempt.started'; stepKind: 'agent' | 'server'; agent: AgentProfileSummary | null }
  | { kind: 'attempt.finished'; route: string; summary: string; facts?: AttemptFacts }
  | { kind: 'attempt.interrupted'; route: string; summary: string }
  | ({ kind: 'command.started' } & CommandStart)
  | ({ kind: 'command.finished' } & CommandEnd)
  | { kind: 'http.call'; method: string; url: string; statusCode: number | null; durationMs: number }
  | ({ kind: 'agent.launched' } & AgentLaunch)
  | ({
      kind: 'agent.finished';
      killReason: string | null;
      tokensIn: number;
      tokensOut: number;
      usd: number;
    } & AgentLaunch)
  | { kind: 'artifact.produced'; artifactKind: string; documentId: number; summary: string }
  | {
      kind: 'issue.opened';
      issueId: string;
      source: string;
      title: string;
      /** The first line of the body, and the step the issue went back to. */
      line?: string;
      returnedTo?: StepName | null;
    }
  | {
      kind: 'handoff.sent';
      handoffId: number;
      targetStep: StepName | null;
      artifactKinds: string[];
      issueIds: string[];
      /** One line for each document passed on. */
      summaries?: string[];
    }
  | { kind: 'handoff.received'; handoffId: number; issueIds: string[]; from?: string }
  | { kind: 'issue.resolved'; issueId: string; evidence: string }
  | ({ kind: 'session.changed' } & SessionChange)
  | {
      kind: 'context.manifest';
      sections: { heading: string; size: number }[];
      /** Files the agent got by reference, as paths inside the sandbox. */
      artifacts: string[];
      cut: { what: string; size: number }[];
    };

export type StepEvent = StepEventBase & StepEventBody;

export type StepEventKind = StepEvent['kind'];

export interface StepEventPage {
  events: StepEvent[];
  /** The `seq` to pass as `after` for the next page, or null when this one is the last. */
  next: number | null;
}
