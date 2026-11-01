import { ExchangeDraft, SampleDraft } from '../../history/visit';
import { KillReason } from '../../limits/limits';
import { IssueBundle } from '../issue-tracker/issue-bundle';

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
