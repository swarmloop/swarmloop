import type { CommitAuthor } from '../git';
import type { Clock } from '../../core/clock';
import type { CodeHostEnv } from '../../integrations/code-host/abstract-code-host';
import type { RebaseJournal } from './journal';
import type { PerRepo } from '../per-repo';

export interface RebaseHosts extends CodeHostEnv {
  clock: Clock;
}

/** Per repository, the commits the run is known to have stood on. */
export type KnownTips = Record<string, string[]>;

export interface RebaseRepoInput {
  root: string;
  key: string;
  repos: string[];
  branch: PerRepo<string>;
  prompt: string | null;
  denied: string[];
  message: PerRepo<string>;
  author?: CommitAuthor | null;
  hosts: RebaseHosts;
  journal: RebaseJournal;
  /** What each repository is known to have stood on. Without it the rule has only the new base to measure from. */
  tips?: KnownTips;
  onBase?: (repo: string, sha: string) => void;
}

export type RebaseStop =
  | { kind: 'clean'; leases: { repo: string; tip: string | null }[] }
  | { kind: 'conflict'; repo: string; files: string[]; stderr: string; base: string; commit: string };
