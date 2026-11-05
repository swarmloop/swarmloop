import { SwarmloopError } from '../../core/swarmloop-error';
import { originRef, promptBase } from '../base-ref';
import { git, gitDetail, gitMissing, gitStderr } from '../git';
import type { RebaseHosts, RebaseStop } from './types';
import { cloneArgs, cloneAuthor, cloneSource, cloneUnmerged, indexDirty } from './clone-index';
import { landConflict, resetHard } from './conflict';
import { gitAt, rebaseStderr } from './workflow';

export async function squashOffMount(input: {
  cwd: string;
  tmp: string;
  repo: string;
  branch: string;
  prompt: string | null;
  denied: string[];
  message: string;
  hosts: RebaseHosts;
  base: string;
}): Promise<RebaseStop | null> {
  const baseSha = await gitAt(input.cwd, input.repo, ['rev-parse', input.base], 'rebase failed', input.hosts);
  const tipSha = await gitAt(input.cwd, input.repo, ['rev-parse', 'HEAD'], 'rebase failed', input.hosts);
  try {
    await git(['-c', 'safe.directory=*', 'clone', '--shared', await cloneSource(input.cwd), input.tmp]);
    await git(cloneArgs(input.tmp, ['checkout', '--detach', baseSha]));
  } catch (error) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${rebaseStderr(gitStderr(error), input.hosts)}`);
  }
  const author = await cloneAuthor(input.cwd);
  const merged = await squashMerge(input.tmp, tipSha, author);
  const unmerged = await cloneUnmerged(input.tmp, input.repo, input.hosts);
  if (unmerged.length > 0) {
    return landConflict({ ...input, baseSha, message: input.message, stderr: merged });
  }
  if (merged) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${rebaseStderr(merged, input.hosts)}`);
  }
  if (!(await indexDirty(input.tmp, input.repo, input.hosts))) {
    const contained = await tipInBase(input.tmp, tipSha, baseSha, input.repo, input.hosts);
    throw new SwarmloopError(`${input.repo} rebase failed: ${contained ? 'already in the base' : 'empty squash'}`);
  }
  if (await sameSquash(input.tmp, tipSha, baseSha, input.message, input.repo, input.hosts)) {
    await resetHard(input.cwd, input.repo, input.hosts, tipSha);
    return null;
  }
  try {
    await git(cloneArgs(input.tmp, [...author, 'commit', '--no-verify', '-m', input.message]));
  } catch (error) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${rebaseStderr(gitStderr(error), input.hosts)}`);
  }
  await gitAt(
    input.cwd,
    input.repo,
    ['-c', 'safe.directory=*', 'fetch', input.tmp, 'HEAD'],
    'rebase failed',
    input.hosts,
  );
  await resetHard(input.cwd, input.repo, input.hosts, 'FETCH_HEAD');
  return null;
}

export async function baseRefFor(cwd: string, prompt: string | null, sha: string): Promise<string> {
  const wanted = promptBase(prompt);
  const names = wanted.kind === 'named' ? [wanted.name, 'main', 'master'] : ['main', 'master'];
  for (const name of names) {
    const ref = originRef(name);
    try {
      if ((await git(['-C', cwd, 'rev-parse', '--verify', '--quiet', ref])) === sha) {
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

async function squashMerge(tmp: string, tipSha: string, author: string[]): Promise<string> {
  try {
    await git(cloneArgs(tmp, [...author, 'merge', '--squash', tipSha]));
    return '';
  } catch (error) {
    return gitStderr(error);
  }
}

async function tipInBase(
  tmp: string,
  tipSha: string,
  baseSha: string,
  repo: string,
  hosts: RebaseHosts,
): Promise<boolean> {
  try {
    await git(cloneArgs(tmp, ['merge-base', '--is-ancestor', tipSha, baseSha]));
    return true;
  } catch (error) {
    if (gitMissing(error)) {
      return false;
    }
    throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
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
      parent = await git(cloneArgs(tmp, ['rev-parse', '--verify', `${tipSha}^`]));
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
    const tip = await git(['-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    return tip || null;
  } catch (error) {
    if (gitMissing(error)) {
      return null;
    }
    throw new SwarmloopError(gitDetail(error));
  }
}
