import { ERROR_CODES } from '../../contract/error-codes';
import { SwarmloopError } from '../../core/swarmloop-error';
import { clearRebaseState, resetHard } from './conflict';
import { fingerprintOf, protectRef } from './journal';
import type { JournalEntry, RebaseJournal } from './journal';
import { restoreHiddenWorktree } from './hidden-worktree';
import type { RebaseHosts } from './types';
import { gitAt } from './workflow';

/**
 * A conflict parked by the squash that measured the run's change from git's merge base (a journal entry with no
 * `ownBase`) was made of more than the run's own change. It is not resolved: the worktree goes back to the head it had
 * before that move, and the move runs again onto the same base by the rule of `ownChangeBase`.
 */
export async function retakeSquashConflict(input: {
  cwd: string;
  repo: string;
  branch: string;
  hosts: RebaseHosts;
  journal: RebaseJournal;
  entry: JournalEntry;
}): Promise<void> {
  const { cwd, repo, hosts, journal } = input;
  let oldHead = '';
  try {
    oldHead = await gitAt(
      cwd,
      repo,
      ['rev-parse', '--verify', `${protectRef(input.branch)}^{commit}`],
      'rebase failed',
    );
  } catch {
    throw new SwarmloopError(`${repo} rebase blocked: the head before the parked move is gone`, {
      code: ERROR_CODES.REBASE_CONFLICT,
    });
  }
  // The parked files and the unmerged index are the squash's, not the run's: back to the base the move parked on.
  await gitAt(cwd, repo, ['reset', '--hard', '-q'], 'rebase failed', hosts);
  await journal.advance(repo, 'changes_preserved', { oldHead, fingerprint: await fingerprintOf(cwd) });
  await resetHard(cwd, repo, hosts, journal, 'oldHead');
  await clearRebaseState(cwd);
  await restoreHiddenWorktree(cwd, repo, hosts, '');
}
