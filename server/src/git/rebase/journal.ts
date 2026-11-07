import { ERROR_CODES } from '../../contract/error-codes';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git } from '../git';
import { worktreeFingerprint } from '../worktree-git';

/** The journal of a rebase: written before the first change and updated at each checkpoint. */
export const REBASE_JOURNAL = 'rebase_journal';

const CHECKPOINTS = [
  'prepared',
  'changes_preserved',
  'applying',
  'conflict',
  'applied',
  'environment_refreshed',
  'verified',
  'completed',
] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];

export interface JournalEntry {
  path: string;
  branch: string;
  /** The tip of the branch before the rebase. */
  oldHead: string;
  /** The files of the worktree at the last checkpoint. */
  fingerprint: string;
  protectRef: string;
  /** The remote tip the push is leased against. */
  expectedRemoteTip: string | null;
  /** The base the rebase applies to. Empty until the base is fetched; never moves after that. */
  baseSha: string;
  checkpoint: Checkpoint;
  /** The squashed commit, recorded before the worktree is reset to it. */
  squashSha?: string;
  /** The generation of the run that began this rebase: a journal of an older generation is history. */
  generation: number;
}

/** The repo names to their entries. */
export type Journal = Record<string, JournalEntry>;

/** Where a `resetHard` may go: only a SHA the entry holds. */
export type ResetTarget = 'oldHead' | 'baseSha' | 'squashSha';

export function parseJournal(body: string | null): Journal {
  return body ? (JSON.parse(body) as Journal) : {};
}

export function atOrPast(entry: JournalEntry, checkpoint: Checkpoint): boolean {
  return CHECKPOINTS.indexOf(entry.checkpoint) >= CHECKPOINTS.indexOf(checkpoint);
}

/** True when a repo of the journal has not completed. */
export function unfinished(journal: Journal): boolean {
  return Object.values(journal).some((entry) => entry.checkpoint !== 'completed');
}

export function protectRef(branch: string): string {
  return `refs/swarmloop/pre-rebase/${branch}`;
}

export function fingerprintOf(path: string): Promise<string> {
  return worktreeFingerprint([{ hostPath: path, containerPath: '/work' }]);
}

/** Where the journal body lives. */
interface JournalStore {
  read(): Promise<string | null>;
  write(body: string): Promise<void>;
}

export class RebaseJournal {
  constructor(
    private readonly store: JournalStore,
    private readonly generation: number,
  ) {}

  async read(): Promise<Journal> {
    return parseJournal(await this.store.read());
  }

  async entry(repo: string): Promise<JournalEntry | undefined> {
    return (await this.read())[repo];
  }

  /** A journal whose repos all completed is history: a new rebase starts a new one. */
  async open(): Promise<Journal> {
    const journal = await this.read();
    if (unfinished(journal)) {
      return journal;
    }
    await this.write({});
    return {};
  }

  async put(repo: string, entry: Omit<JournalEntry, 'generation'>): Promise<void> {
    await this.write({ ...(await this.read()), [repo]: { ...entry, generation: this.generation } });
  }

  async advance(repo: string, checkpoint: Checkpoint, patch: Partial<JournalEntry> = {}): Promise<JournalEntry> {
    const journal = await this.read();
    const current = journal[repo];
    if (!current) {
      throw new Error(`${repo} has no journal entry`);
    }
    const next = { ...current, ...patch, checkpoint };
    await this.write({ ...journal, [repo]: next });
    return next;
  }

  private write(journal: Journal): Promise<void> {
    return this.store.write(`${JSON.stringify(journal)}\n`);
  }
}

/** The environment is refreshed: each repo that applied is checked on its branch and completes. A repo in conflict stays. */
export async function completeRebase(journal: RebaseJournal): Promise<void> {
  for (const [repo, entry] of Object.entries(await journal.read())) {
    if (!atOrPast(entry, 'applied') || entry.checkpoint === 'completed') {
      continue;
    }
    await journal.advance(repo, 'environment_refreshed');
    if ((await git(['-C', entry.path, 'branch', '--show-current'])) !== entry.branch) {
      throw new SwarmloopError(`${repo} branch is missing`, { code: ERROR_CODES.REBASE_CONFLICT });
    }
    await journal.advance(repo, 'verified');
    await journal.advance(repo, 'completed');
  }
}
