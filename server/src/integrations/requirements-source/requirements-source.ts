import type { SampleDraft } from '../../history/visit';
import type { KillReason } from '../../core/kill-reason';
import type { IssueBundle } from '../issue-tracker/issue-bundle';

export interface RequirementsInput {
  key: string;
  runDir: string;
  bundle: IssueBundle;
  agentCalls: number;
  spentUsd: number;
  prompt?: string;
  issueKeys?: string[];
  bundles?: IssueBundle[];
}

export interface RequirementsWrite {
  body: string;
  calls: number;
  usd: number;
  tokensIn: number;
  tokensOut: number;
  /** The rows of the call log the write's agent calls made; none when no agent ran. */
  callIds: number[];
  killReason: KillReason | null;
  samples: SampleDraft[];
  resumed: boolean;
}

export interface RequirementsSource {
  write(input: RequirementsInput): Promise<RequirementsWrite>;
}
