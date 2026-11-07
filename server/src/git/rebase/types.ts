import type { Clock } from '../../core/clock';
import type { CodeHostEnv } from '../../integrations/code-host/abstract-code-host';
import type { RebaseJournal } from './journal';

export interface RebaseHosts extends CodeHostEnv {
  clock: Clock;
}

export interface RebaseRepoInput {
  root: string;
  key: string;
  repos: string[];
  branch: string;
  prompt: string | null;
  denied: string[];
  message: string;
  hosts: RebaseHosts;
  journal: RebaseJournal;
  onBase?: (repo: string, sha: string) => void;
}

export type RebaseStop =
  | { kind: 'clean'; leases: { repo: string; tip: string | null }[] }
  | { kind: 'conflict'; repo: string; files: string[]; stderr: string; base: string; commit: string };
