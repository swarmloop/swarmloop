import type { ExchangeDraft, SampleDraft } from '../../history/visit';
import type { KillReason } from '../../core/kill-reason';
import type { IssueBundle } from '../issue-tracker/issue-bundle';

export interface RequirementsInput {
  key: string;
  runDir: string;
  bundle: IssueBundle;
  agentCalls: number;
  spentUsd: number;
  tokensInRun: number;
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
  exchange: ExchangeDraft | null;
  killReason: KillReason | null;
  samples: SampleDraft[];
  resumed: boolean;
}

export interface RequirementsSource {
  write(input: RequirementsInput): Promise<RequirementsWrite>;
}
