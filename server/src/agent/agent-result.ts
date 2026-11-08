import type { SampleDraft } from '../history/visit';
import type { KillReason } from './limits';

export interface AgentRunResult {
  responseText: string;
  chatId: string | null;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  killReason: KillReason | null;
  exitCode: number;
  output?: string;
  resumed: boolean;
  /** Set while the stream was read. A later check does not parse the log again. */
  decided?: boolean;
  /** A background task was stopped or killed after the result line, and the answer lacks a required section. */
  backgroundKilled?: boolean;
  /** A resumed launch whose output was only orphan notifications and an empty result. */
  orphanOnly?: boolean;
  calls: number;
  samples: SampleDraft[];
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}
