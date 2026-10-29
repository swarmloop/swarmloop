import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { codeHostFromOrigin, selectedHost } from '../providers/host-credentials';
import { SwarmloopError } from '../swarmloop-error';
import { originRef, promptBase } from './base-ref';
import { allowedPaths, isDenied, porcelainPaths } from './commit/commit-paths';
import { githubPushUrl, gitlabPushUrl } from './commit/commit.service';
import { git, gitDetail, gitMissing, gitRaw, gitStderr } from './git';
import { worktreePath } from './repo-names';

/** Set while a conflict rebase still has to be resolved, then reviewed on the new diff. */
export const REBASE_CONFLICT = 'rebase_conflict';

export interface RebaseHosts {
  GITLAB_BASE_URL: string;
  GITLAB_TOKEN: string;
  GITHUB_BASE_URL: string;
  GITHUB_TOKEN: string;
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
}

/** Clean publishes the tips captured before the fetch. Conflict names the files still in progress. */
export type RebaseStop =
  | { kind: 'clean'; leases: { repo: string; tip: string | null }[] }
  | { kind: 'conflict'; repo: string; files: string[]; stderr: string; base: string; commit: string };

/** Replay each feature branch onto the fetched remote source. Stop at the first conflict and leave it in progress. */
export async function rebaseFeatureRepos(input: RebaseRepoInput): Promise<RebaseStop> {
  promptBase(input.prompt);
  const leases: { repo: string; tip: string | null }[] = [];
  for (const repo of input.repos) {
    const cwd = checkout(input.root, input.key, repo);
    const tip = await publishedTip(cwd, input.branch);
    const outcome = await rebaseFeatureRepo({
      cwd,
      repo,
      branch: input.branch,
      prompt: input.prompt,
      denied: input.denied,
      message: input.message,
      hosts: input.hosts,
    });
    if (outcome) {
      return outcome;
    }
    leases.push({ repo, tip });
  }
  return { kind: 'clean', leases };
}

export async function rebaseInProgress(cwd: string): Promise<boolean> {
  if (await gitPathExists(cwd, 'rebase-merge') || await gitPathExists(cwd, 'rebase-apply')) {
    return true;
  }
  return (await unmergedPaths(cwd)).length > 0;
}

export async function unmergedPaths(cwd: string): Promise<string[]> {
  let raw = '';
  try {
    raw = await gitRaw(['-C', cwd, 'diff', '--name-only', '--diff-filter=U', '-z']);
  } catch (error) {
    if (!gitMissing(error)) {
      throw new SwarmloopError(gitDetail(error));
    }
  }
  return raw
    .split('\0')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

async function rebaseFeatureRepo(input: {
  cwd: string;
  repo: string;
  branch: string;
  prompt: string | null;
  denied: string[];
  message: string;
  hosts: RebaseHosts;
}): Promise<RebaseStop | null> {
  if (await rebaseInProgress(input.cwd)) {
    return continueOrStop(input.cwd, input.repo, input.denied, await rebaseOntoName(input.cwd, input.prompt), '');
  }
  const current = await gitAt(input.cwd, input.repo, ['branch', '--show-current'], 'branch failed');
  if (current !== input.branch) {
    throw new SwarmloopError(`${input.repo} branch is missing`);
  }
  const porcelain = await gitRawAt(input.cwd, input.repo, ['status', '--porcelain=v1', '-z', '-uall']);
  const deniedDirty = porcelainPaths(porcelain).filter((path) => isDenied(path, input.denied));
  if (deniedDirty.length > 0 && allowedPaths(input.repo, porcelain, input.denied).length === 0) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${deniedDirty[0]}`);
  }
  await commitAllowed(input.cwd, input.repo, input.denied, input.message);
  const base = await storedBase(input.cwd, input.repo, input.prompt, input.hosts);
  await hideDeniedWorktree(input.cwd, input.repo, input.denied);
  try {
    await git(['-C', input.cwd, 'rebase', base]);
  } catch (error) {
    if (await rebaseInProgress(input.cwd)) {
      return continueOrStop(input.cwd, input.repo, input.denied, base, gitStderr(error));
    }
    await abortRebase(input.cwd);
    await restoreRebaseStash(input.cwd, input.repo);
    throw new SwarmloopError(`${input.repo} rebase failed: ${gitDetail(error)}`);
  }
  await restoreRebaseStash(input.cwd, input.repo);
  return null;
}

/** Stage a resolution that no longer has markers, then continue. A real conflict keeps its files and stderr. */
async function continueOrStop(cwd: string, repo: string, denied: string[], base: string, stderr: string): Promise<RebaseStop | null> {
  const blocked = (await unmergedPaths(cwd)).find((file) => isDenied(file, denied));
  if (blocked) {
    await abortRebase(cwd);
    await restoreRebaseStash(cwd, repo);
    throw new SwarmloopError(`${repo} rebase failed: ${blocked}`);
  }
  await stageResolved(cwd, repo);
  const files = await unmergedPaths(cwd);
  if (files.length > 0) {
    return { kind: 'conflict', repo, files, stderr, base, commit: await replayedSubject(cwd) };
  }
  await keepMarkedCommit(cwd, repo);
  await ensureRebaseMessage(cwd);
  try {
    await git(['-C', cwd, ...(await authorArgs(cwd)), '-c', 'core.editor=true', 'rebase', '--continue'], { GIT_EDITOR: 'true' });
  } catch (error) {
    if (await rebaseInProgress(cwd)) {
      return { kind: 'conflict', repo, files: await unmergedPaths(cwd), stderr: gitStderr(error), base, commit: await replayedSubject(cwd) };
    }
    throw new SwarmloopError(`${repo} rebase failed: ${gitDetail(error)}`);
  }
  if (await rebaseInProgress(cwd)) {
    return { kind: 'conflict', repo, files: await unmergedPaths(cwd), stderr, base, commit: await replayedSubject(cwd) };
  }
  await restoreRebaseStash(cwd, repo);
  return null;
}

async function stageResolved(cwd: string, repo: string): Promise<void> {
  const resolved = (await unmergedPaths(cwd)).filter((file) => !conflictMarkers(join(cwd, file)));
  if (resolved.length === 0) {
    return;
  }
  await gitAt(cwd, repo, ['add', '--', ...resolved], 'rebase failed');
}

function conflictMarkers(file: string): boolean {
  try {
    const text = readFileSync(file, 'utf8');
    return text.includes('<<<<<<<') && text.includes('>>>>>>>');
  } catch {
    return false;
  }
}

/** An empty resolution would drop a commit git is still replaying. Keep that commit's tree. */
async function keepMarkedCommit(cwd: string, repo: string): Promise<void> {
  let replay = '';
  try {
    replay = await git(['-C', cwd, 'rev-parse', '--verify', '--quiet', 'REBASE_HEAD']);
  } catch (error) {
    if (gitMissing(error)) {
      return;
    }
    throw new SwarmloopError(`${repo} rebase failed: ${gitDetail(error)}`);
  }
  try {
    await git(['-C', cwd, 'diff', '--cached', '--quiet', 'HEAD']);
  } catch (error) {
    if (gitMissing(error)) {
      return;
    }
    throw new SwarmloopError(`${repo} rebase failed: ${gitDetail(error)}`);
  }
  const files = (await gitRaw(['-C', cwd, 'diff', '--name-only', '-z', 'HEAD', replay])).split('\0').filter((file) => file.length > 0);
  if (files.length === 0) {
    return;
  }
  await gitAt(cwd, repo, ['checkout', replay, '--', ...files], 'rebase failed');
}

async function ensureRebaseMessage(cwd: string): Promise<void> {
  const target = await resolveGitPath(cwd, 'rebase-merge/message');
  if (!target || existsSync(target)) {
    return;
  }
  const message = await git(['-C', cwd, 'log', '-1', '--format=%B', 'REBASE_HEAD']);
  writeFileSync(target, message.endsWith('\n') ? message : `${message}\n`);
}

async function replayedSubject(cwd: string): Promise<string> {
  try {
    return await git(['-C', cwd, 'log', '-1', '--format=%s', 'REBASE_HEAD']);
  } catch (error) {
    if (gitMissing(error)) {
      return '';
    }
    throw new SwarmloopError(gitDetail(error));
  }
}

async function rebaseOntoName(cwd: string, prompt: string | null): Promise<string> {
  const onto = (await readGitText(cwd, 'rebase-merge/onto')).trim();
  const wanted = promptBase(prompt);
  const names = wanted.kind === 'named' ? [wanted.name, 'main', 'master'] : ['main', 'master'];
  for (const name of names) {
    const ref = originRef(name);
    if (onto && (await sameCommit(cwd, onto, ref))) {
      return ref;
    }
  }
  return originRef(names[0] ?? 'main');
}

async function publishedTip(cwd: string, branch: string): Promise<string | null> {
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

async function restoreRebaseStash(cwd: string, repo: string): Promise<void> {
  let list = '';
  try {
    list = await git(['-C', cwd, 'stash', 'list']);
  } catch (error) {
    if (gitMissing(error)) {
      return;
    }
    throw new SwarmloopError(`${repo} rebase failed: ${gitDetail(error)}`);
  }
  const line = list.split('\n').find((item) => item.includes('swarmloop-rebase'));
  if (!line) {
    return;
  }
  const ref = line.slice(0, line.indexOf(':')).trim();
  if (!ref) {
    return;
  }
  let names = '';
  try {
    names = await gitRaw(['-C', cwd, 'ls-tree', '-r', '--name-only', '-z', `${ref}^3`]);
  } catch {
    names = '';
  }
  const files = names.split('\0').map((item) => item.trim()).filter((item) => item.length > 0);
  if (files.length > 0) {
    await gitAt(cwd, repo, ['checkout', `${ref}^3`, '--', ...files], 'rebase failed');
    await gitAt(cwd, repo, ['stash', 'drop', ref], 'rebase failed');
    return;
  }
  await gitAt(cwd, repo, ['stash', 'pop', '--quiet', ref], 'rebase failed');
}

async function abortRebase(cwd: string): Promise<void> {
  try {
    await git(['-C', cwd, 'rebase', '--abort']);
  } catch {
    // The rebase never started, so there is nothing to abort.
  }
}

async function sameCommit(cwd: string, sha: string, ref: string): Promise<boolean> {
  try {
    return (await git(['-C', cwd, 'rev-parse', '--verify', '--quiet', ref])) === sha;
  } catch (error) {
    if (gitMissing(error)) {
      return false;
    }
    throw new SwarmloopError(gitDetail(error));
  }
}

async function readGitText(cwd: string, name: string): Promise<string> {
  const target = await resolveGitPath(cwd, name);
  if (!target || !existsSync(target)) {
    return '';
  }
  return readFileSync(target, 'utf8');
}

async function resolveGitPath(cwd: string, name: string): Promise<string | null> {
  try {
    const printed = await git(['-C', cwd, 'rev-parse', '--git-path', name]);
    return isAbsolute(printed) ? printed : join(cwd, printed);
  } catch {
    return null;
  }
}

async function commitAllowed(cwd: string, repo: string, denied: string[], message: string): Promise<void> {
  const porcelain = await gitRawAt(cwd, repo, ['status', '--porcelain=v1', '-z', '-uall']);
  const stage = allowedPaths(repo, porcelain, denied).map((item) => item.path);
  const held = deniedInIndex(porcelain, denied);
  if (held.length > 0) {
    await gitAt(cwd, repo, ['reset', '-q', 'HEAD', '--', ...held], 'commit failed');
  }
  if (stage.length === 0) {
    return;
  }
  await gitAt(cwd, repo, ['add', '--', ...stage], 'commit failed');
  await gitAt(cwd, repo, [...(await authorArgs(cwd)), 'commit', '--no-verify', '--only', '-m', message, '--', ...stage], 'commit failed');
}

function deniedInIndex(porcelain: string, denied: string[]): string[] {
  return deniedAt(porcelain, denied, 0);
}

function deniedInWorktree(porcelain: string, denied: string[]): string[] {
  return deniedAt(porcelain, denied, 1);
}

function deniedAt(porcelain: string, denied: string[], column: 0 | 1): string[] {
  const parts = porcelain.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index] ?? '';
    if (entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) {
      continue;
    }
    if (status.includes('R') || status.includes('C')) {
      index += 1;
    }
    const mark = status[column] ?? ' ';
    if (mark === ' ' || mark === '?' || !isDenied(path, denied)) {
      continue;
    }
    paths.push(path);
  }
  return paths;
}

async function hideDeniedWorktree(cwd: string, repo: string, denied: string[]): Promise<void> {
  const dirty = deniedInWorktree(await gitRawAt(cwd, repo, ['status', '--porcelain=v1', '-z', '-uall']), denied);
  if (dirty.length === 0) {
    return;
  }
  await gitAt(cwd, repo, ['stash', 'push', '-m', 'swarmloop-rebase', '--', ...dirty], 'rebase failed');
}

async function authorArgs(cwd: string): Promise<string[]> {
  try {
    const email = (await git(['-C', cwd, 'config', '--local', '--get', 'user.email'])).trim();
    if (email) {
      return [];
    }
  } catch {
    // Fall through to the environment author used by commit.
  }
  const name = process.env.GIT_AUTHOR_NAME?.trim() ?? '';
  const email = process.env.GIT_AUTHOR_EMAIL?.trim() ?? '';
  if (!name || !email) {
    return [];
  }
  return ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
}

async function storedBase(cwd: string, repo: string, prompt: string | null, hosts: RebaseHosts): Promise<string> {
  const wanted = promptBase(prompt);
  const origin = await originUrl(cwd, repo);
  if (!origin) {
    if (wanted.kind === 'named') {
      throw new SwarmloopError(`${repo} has no ${originRef(wanted.name)}`);
    }
    return 'HEAD';
  }
  const names = wanted.kind === 'named' ? [wanted.name] : ['main', 'master'];
  for (const name of names) {
    if (await fetchSource(cwd, repo, origin, name, hosts)) {
      return originRef(name);
    }
  }
  const missing = wanted.kind === 'named' ? originRef(wanted.name) : 'origin/master';
  throw new SwarmloopError(`${repo} has no ${missing}`);
}

/** Fetch one source branch from the remote. A missing ref tries the next candidate. Any other fetch failure stops the rebase. */
async function fetchSource(cwd: string, repo: string, origin: string, name: string, hosts: RebaseHosts): Promise<boolean> {
  const gitlab = gitlabPushUrl(origin, hosts.GITLAB_BASE_URL, hosts.GITLAB_TOKEN);
  const url = gitlab ?? githubPushUrl(origin, hosts.GITHUB_BASE_URL, hosts.GITHUB_TOKEN);
  const refspec = `+refs/heads/${name}:refs/remotes/origin/${name}`;
  const secret = gitlab ? hosts.GITLAB_TOKEN : hosts.GITHUB_TOKEN;
  try {
    if (url) {
      await git(['-C', cwd, 'fetch', url, refspec], { GIT_TERMINAL_PROMPT: '0' });
    } else if (origin.startsWith('git@') || origin.startsWith('ssh://')) {
      throw new SwarmloopError(sshFailure(repo, origin, hosts));
    } else {
      await git(['-C', cwd, 'fetch', 'origin', refspec], { GIT_TERMINAL_PROMPT: '0' });
    }
    return true;
  } catch (error) {
    if (error instanceof SwarmloopError) {
      throw error;
    }
    const detail = redact(gitDetail(error), secret);
    if (detail.includes("couldn't find remote ref")) {
      return false;
    }
    throw new SwarmloopError(`${repo} rebase failed: ${detail}`);
  }
}

async function originUrl(cwd: string, repo: string): Promise<string | null> {
  try {
    const url = (await git(['-C', cwd, 'remote', 'get-url', 'origin'])).trim();
    return url || null;
  } catch (error) {
    if (gitDetail(error).includes('No such remote')) {
      return null;
    }
    throw new SwarmloopError(`${repo} rebase failed: ${gitDetail(error)}`);
  }
}

function sshFailure(repo: string, origin: string, hosts: RebaseHosts): string {
  const name = codeHostFromOrigin(origin, hosts.GITLAB_BASE_URL, hosts.GITHUB_BASE_URL);
  if (!name) {
    return `${repo} rebase failed: code host is missing`;
  }
  const host = selectedHost(hosts, name);
  if (!host.token.trim()) {
    return `${repo} rebase failed: ${host.tokenKey} is missing`;
  }
  if (!host.baseUrl.trim()) {
    return `${repo} rebase failed: ${host.baseKey} is missing`;
  }
  return `${repo} rebase failed: origin is not ${host.baseKey}`;
}

function redact(detail: string, secret: string): string {
  const token = secret.trim();
  if (!token) {
    return detail;
  }
  return detail.split(token).join('***').split(encodeURIComponent(token)).join('***');
}

function checkout(root: string, key: string, repo: string): string {
  const cwd = worktreePath(root, key, repo);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new SwarmloopError(`${repo} is not a worktree`);
  }
  return cwd;
}

async function gitPathExists(cwd: string, name: string): Promise<boolean> {
  try {
    const printed = await git(['-C', cwd, 'rev-parse', '--git-path', name]);
    const target = isAbsolute(printed) ? printed : join(cwd, printed);
    return existsSync(target);
  } catch {
    return false;
  }
}

async function gitAt(cwd: string, repo: string, args: string[], failure: string): Promise<string> {
  try {
    return await git(['-C', cwd, ...args]);
  } catch (error) {
    throw new SwarmloopError(`${repo} ${failure}: ${gitDetail(error)}`);
  }
}

async function gitRawAt(cwd: string, repo: string, args: string[]): Promise<string> {
  try {
    return await gitRaw(['-C', cwd, ...args]);
  } catch (error) {
    throw new SwarmloopError(`${repo} status failed: ${gitDetail(error)}`);
  }
}
