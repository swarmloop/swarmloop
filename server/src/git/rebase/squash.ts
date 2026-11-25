import { SwarmloopError } from '../../core/swarmloop-error';
import { originRef, promptBase } from '../base-ref';
import { git, gitDetail, gitMissing, gitStderr, type CommitAuthor, type CommitIdentity } from '../git';
import type { RebaseHosts, RebaseStop } from './types';
import { hasOwnChange } from './own-change';
import { squashRefFor, type RebaseJournal } from './journal';
import { cloneArgs, cloneAuthor, cloneSource, cloneUnmerged, indexDirty } from './clone-index';
import { landConflict, resetHard } from './conflict';
import { gitAt, rebaseStderr } from './workflow';

export async function squashOffMount(input: {
  cwd: string;
  tmp: string;
  repo: string;
  key: string;
  branch: string;
  prompt: string | null;
  denied: string[];
  message: string;
  author?: CommitAuthor | null;
  hosts: RebaseHosts;
  journal: RebaseJournal;
  base: string;
  /** The commit the run's own change is measured from: only `ownBase..HEAD` is carried onto the base. */
  ownBase: string;
}): Promise<RebaseStop | null> {
  const baseSha = await gitAt(input.cwd, input.repo, ['rev-parse', input.base], 'rebase failed', input.hosts);
  const tipSha = await gitAt(input.cwd, input.repo, ['rev-parse', 'HEAD'], 'rebase failed', input.hosts);
  if (!(await hasOwnChange(input.cwd, input.ownBase))) {
    return standOnBase(input);
  }
  try {
    await git(['-c', 'safe.directory=*', 'clone', '--shared', await cloneSource(input.cwd), input.tmp]);
    await git(cloneArgs(input.tmp, ['checkout', '--detach', baseSha]));
  } catch (error) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${rebaseStderr(gitStderr(error), input.hosts)}`);
  }
  const author = await cloneAuthor(input.cwd, input.author);
  const merged = await carryOwnChange(input.tmp, tipSha, input.ownBase, author);
  const unmerged = await cloneUnmerged(input.tmp, input.repo, input.hosts);
  if (unmerged.length > 0) {
    return landConflict({ ...input, baseSha, message: input.message, stderr: merged });
  }
  if (merged) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${rebaseStderr(merged, input.hosts)}`);
  }
  if (!(await indexDirty(input.tmp, input.repo, input.hosts))) {
    // What the run changed is already in the base: it stands on the base, with nothing to commit.
    return standOnBase(input);
  }
  if (await sameSquash(input.tmp, tipSha, baseSha, input.message, input.repo, input.hosts)) {
    await resetHard(input.cwd, input.repo, input.hosts, input.journal, 'oldHead');
    return null;
  }
  try {
    await git(cloneArgs(input.tmp, [...author.args, 'commit', '--no-verify', '-m', input.message]), author.env);
  } catch (error) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${rebaseStderr(gitStderr(error), input.hosts)}`);
  }
  const made = await git(cloneArgs(input.tmp, ['rev-parse', 'HEAD']));
  const madeTree = await git(cloneArgs(input.tmp, ['rev-parse', 'HEAD^{tree}']));
  const squashRef = squashRefFor(input.key);
  await gitAt(input.cwd, input.repo, ['update-ref', '-d', squashRef], 'rebase failed', input.hosts);
  await gitAt(
    input.cwd,
    input.repo,
    ['-c', 'safe.directory=*', 'fetch', '--no-write-fetch-head', input.tmp, `HEAD:${squashRef}`],
    'rebase failed',
    input.hosts,
  );
  const found = await gitAt(
    input.cwd,
    input.repo,
    ['rev-parse', '--verify', `${squashRef}^{commit}`],
    'rebase failed',
    input.hosts,
  );
  if (found !== made) {
    throw new SwarmloopError(
      `${input.repo} rebase failed: the squash ${made} is not what the worktree would move to (${found})`,
    );
  }
  await input.journal.advance(input.repo, 'applying', { squashSha: made });
  await resetHard(input.cwd, input.repo, input.hosts, input.journal, 'squashSha', madeTree);
  return null;
}

export async function baseRefFor(cwd: string, prompt: string | null, sha: string): Promise<string> {
  const wanted = promptBase(prompt);
  const names = wanted.kind === 'named' ? [wanted.name, 'main', 'master'] : ['main', 'master'];
  for (const name of names) {
    const ref = originRef(name);
    try {
      if ((await git(['-C', cwd, 'rev-parse', '--verify', '--quiet', ref], undefined, { answers: [1] })) === sha) {
        return ref;
      }
    } catch (error) {
      if (!gitMissing(error)) {
        throw new SwarmloopError(gitDetail(error));
      }
    }
  }
  return originRef(names[0] ?? 'main');
}

/** A run with nothing of its own to carry stands on the new base: no clone, no conflict, no commit. */
async function standOnBase(input: {
  cwd: string;
  repo: string;
  hosts: RebaseHosts;
  journal: RebaseJournal;
}): Promise<null> {
  await resetHard(input.cwd, input.repo, input.hosts, input.journal, 'baseSha');
  return null;
}

/**
 * Puts the change `ownBase..tipSha` on the checked out base, in the index and not committed: the way
 * `git rebase --onto <base> <ownBase>` applies it. The change is a scratch commit of the tip's tree on `ownBase`,
 * so the three-way merge has `ownBase` as its old side whatever history lies between it and the tip.
 * The git message of a failure, empty when the change applied.
 */
async function carryOwnChange(tmp: string, tipSha: string, ownBase: string, author: CommitIdentity): Promise<string> {
  try {
    const scratch = await git(
      cloneArgs(tmp, [...author.args, 'commit-tree', `${tipSha}^{tree}`, '-p', ownBase, '-m', 'own change']),
      author.env,
    );
    await git(cloneArgs(tmp, [...author.args, 'cherry-pick', '--no-commit', scratch]), author.env);
    return '';
  } catch (error) {
    return gitStderr(error);
  }
}

async function sameSquash(
  tmp: string,
  tipSha: string,
  baseSha: string,
  message: string,
  repo: string,
  hosts: RebaseHosts,
): Promise<boolean> {
  try {
    const staged = await git(cloneArgs(tmp, ['write-tree']));
    const tipTree = await git(cloneArgs(tmp, ['rev-parse', `${tipSha}^{tree}`]));
    const body = await git(cloneArgs(tmp, ['log', '-1', '--format=%B', tipSha]));
    let parent = '';
    try {
      parent = await git(cloneArgs(tmp, ['rev-parse', '--verify', `${tipSha}^`]), undefined, { answers: [128] });
    } catch {
      parent = '';
    }
    return staged === tipTree && parent === baseSha && body === message.trim();
  } catch (error) {
    throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
  }
}

export async function publishedTip(cwd: string, branch: string): Promise<string | null> {
  try {
    const tip = await git(['-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], undefined, {
      answers: [1],
    });
    return tip || null;
  } catch (error) {
    if (gitMissing(error)) {
      return null;
    }
    throw new SwarmloopError(gitDetail(error));
  }
}
