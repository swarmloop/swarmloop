import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, sep } from 'path';
import { codeHostFromOrigin, selectedHost } from '../providers/host-credentials';
import { SwarmloopError } from '../swarmloop-error';
import { originRef, promptBase } from './base-ref';
import { allowedPaths, deniedIndexPaths, isDenied, porcelainPaths, stageSelection } from '../steps/commit/commit-paths';
import { githubPushUrl, gitlabPushUrl } from '../steps/commit/commit.service';
import { authorArgs, git, gitDetail, gitMissing, gitRaw, gitStderr, originUrl, redact } from './git';
import { worktreePath } from '../steps/repo-names';

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

/** Squash each feature branch onto the fetched base. Stop at the first conflict. */
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
  const state = await readRebaseState(input.cwd, input.repo);
  if (state) {
    return resumeRebase({ ...input, state });
  }
  await abortMountedRebase(input.cwd, input.repo, input.hosts);
  const current = await gitAt(input.cwd, input.repo, ['branch', '--show-current'], 'branch failed');
  if (current !== input.branch) {
    throw new SwarmloopError(`${input.repo} branch is missing`);
  }
  const porcelain = await gitRawAt(input.cwd, input.repo, ['status', '--porcelain=v1', '-z', '-uall']);
  const deniedDirty = porcelainPaths(porcelain).filter((path) => isDenied(path, input.denied));
  if (
    deniedDirty.length > 0 &&
    allowedPaths(input.repo, porcelain, input.denied).length === 0 &&
    !(await branchHasAllowedChange(input.cwd, input.prompt, input.denied))
  ) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${deniedDirty[0]}`);
  }
  await commitAllowed(input.cwd, input.repo, input.denied, input.message);
  const after = await gitRawAt(input.cwd, input.repo, ['status', '--porcelain=v1', '-z', '-uall']);
  const leftover = porcelainPaths(after).find((path) => !isDenied(path, input.denied));
  if (leftover) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${leftover}`);
  }
  const base = await storedBase(input.cwd, input.repo, input.prompt, input.hosts, 'rebase');
  await hideDeniedWorktree(input.cwd, input.repo, input.denied, input.hosts);
  const scratch = await mkdtemp(join(tmpdir(), 'swarmloop-rebase-'));
  const tmp = join(scratch, 'clone');
  let hidden = true;
  try {
    const outcome = await squashOffMount({ ...input, base, tmp });
    try {
      await restoreHiddenWorktree(input.cwd, input.repo, input.hosts, '');
    } catch (error) {
      // Restore cannot apply onto an unmerged index. The conflict still returns; resume restores this ref.
      if (outcome?.kind !== 'conflict') {
        throw error;
      }
    }
    hidden = false;
    return outcome;
  } catch (error) {
    if (hidden) {
      try {
        await restoreHiddenWorktree(input.cwd, input.repo, input.hosts, '');
      } catch {
        // Restore failed. Report the rebase error.
      }
    }
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** True when this branch already changes an allowed path relative to the local base. A denied-only branch does not. */
async function branchHasAllowedChange(cwd: string, prompt: string | null, denied: string[]): Promise<boolean> {
  const wanted = promptBase(prompt);
  const names = wanted.kind === 'named' ? [wanted.name] : ['main', 'master'];
  let base: string | null = null;
  for (const name of names) {
    const ref = originRef(name);
    try {
      await git(['-C', cwd, 'rev-parse', '--verify', '--quiet', ref]);
      base = ref;
      break;
    } catch (error) {
      if (!gitMissing(error)) {
        throw error;
      }
    }
  }
  if (!base) {
    return false;
  }
  try {
    const listed = await gitRaw(['-C', cwd, 'diff', '--name-only', '-z', `${base}...HEAD`]);
    return listed.split('\0').some((path) => path.length > 0 && !isDenied(path, denied));
  } catch {
    return false;
  }
}

const EMPTY_BLOB = '0000000000000000000000000000000000000000';

interface StageEntry {
  mode: string;
  sha: string;
  stage: string;
  path: string;
}

interface RebaseState {
  baseSha: string;
  message: string;
}

async function resumeRebase(input: {
  cwd: string;
  repo: string;
  branch: string;
  prompt: string | null;
  denied: string[];
  hosts: RebaseHosts;
  state: RebaseState;
}): Promise<RebaseStop | null> {
  const current = await gitAt(input.cwd, input.repo, ['branch', '--show-current'], 'branch failed');
  if (current !== input.branch) {
    throw new SwarmloopError(`${input.repo} branch is missing`);
  }
  const files = await unmergedPaths(input.cwd);
  const blocked = files.find((file) => isDenied(file, input.denied) && conflictMarkers(join(input.cwd, file)));
  if (blocked) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${blocked}`);
  }
  if (files.some((file) => conflictMarkers(join(input.cwd, file)))) {
    return {
      kind: 'conflict',
      repo: input.repo,
      files,
      stderr: '',
      base: await baseRefFor(input.cwd, input.prompt, input.state.baseSha),
      commit: input.state.message,
    };
  }
  const porcelain = await gitRawAt(input.cwd, input.repo, ['status', '--porcelain=v1', '-z', '-uall']);
  const held = deniedIndexPaths(porcelain, input.denied);
  if (held.length > 0) {
    await gitAt(input.cwd, input.repo, ['reset', '-q', 'HEAD', '--', ...held], 'rebase failed', input.hosts);
  }
  const add = stageSelection(porcelain, input.denied).add;
  if (add.length > 0) {
    await gitAt(input.cwd, input.repo, ['add', '--', ...add], 'rebase failed', input.hosts);
  }
  await gitAt(
    input.cwd,
    input.repo,
    [...(await authorArgs(input.cwd)), 'commit', '--no-verify', '-m', input.state.message],
    'rebase failed',
    input.hosts,
  );
  const target = await resolveGitPath(input.cwd, 'swarmloop-rebase');
  if (target && existsSync(target)) {
    unlinkSync(target);
  }
  await restoreHiddenWorktree(input.cwd, input.repo, input.hosts, '');
  return null;
}

async function abortMountedRebase(cwd: string, repo: string, hosts: RebaseHosts): Promise<void> {
  if (!(await gitPathExists(cwd, 'rebase-merge')) && !(await gitPathExists(cwd, 'rebase-apply'))) {
    return;
  }
  try {
    await git(['-C', cwd, 'rebase', '--abort']);
  } catch (error) {
    throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
  }
}

async function squashOffMount(input: {
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
  await gitAt(input.cwd, input.repo, ['-c', 'safe.directory=*', 'fetch', input.tmp, 'HEAD'], 'rebase failed', input.hosts);
  await resetHard(input.cwd, input.repo, input.hosts, 'FETCH_HEAD');
  return null;
}

async function landConflict(input: {
  cwd: string;
  tmp: string;
  repo: string;
  branch: string;
  denied: string[];
  base: string;
  baseSha: string;
  message: string;
  hosts: RebaseHosts;
  stderr: string;
}): Promise<RebaseStop> {
  const unmerged = await cloneUnmerged(input.tmp, input.repo, input.hosts);
  const blocked = unmerged.find((file) => isDenied(file, input.denied));
  if (blocked) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${blocked}`);
  }
  let stageList = '';
  try {
    stageList = await gitRaw(cloneArgs(input.tmp, ['ls-files', '--stage', '-z']));
  } catch (error) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${rebaseStderr(gitStderr(error), input.hosts)}`);
  }
  const entries = parseStageList(stageList);
  const files = readCloneFiles(input.tmp, entries.map((entry) => entry.path));
  const oldTip = await gitAt(input.cwd, input.repo, ['rev-parse', 'HEAD'], 'rebase failed', input.hosts);
  await gitAt(input.cwd, input.repo, ['update-ref', `refs/swarmloop/pre-rebase/${input.branch}`, oldTip], 'rebase failed', input.hosts);
  await resetHard(input.cwd, input.repo, input.hosts, input.baseSha);
  for (const [path, file] of files) {
    const full = copiedDestination(input.cwd, path);
    removeCopiedPath(full);
    if (file.kind === 'link') {
      symlinkSync(file.target, full);
    } else {
      writeFileSync(full, file.bytes);
    }
  }
  const present = new Set(entries.map((entry) => entry.path));
  const tracked = (await gitRawAt(input.cwd, input.repo, ['ls-files', '-z'])).split('\0').filter((path) => path.length > 0);
  const removed = tracked.filter((path) => !present.has(path));
  for (const path of removed) {
    removeCopiedPath(join(input.cwd, path));
  }
  await importCloneBlobs(input.cwd, input.tmp, input.repo, input.hosts, entries);
  await loadCloneIndex(input.cwd, input.repo, input.hosts, entries, removed);
  const target = await resolveGitPath(input.cwd, 'swarmloop-rebase');
  if (!target) {
    throw new SwarmloopError(`${input.repo} rebase failed: swarmloop-rebase`);
  }
  writeFileSync(target, `${input.baseSha}\n${input.message}\n`);
  return {
    kind: 'conflict',
    repo: input.repo,
    files: await unmergedPaths(input.cwd),
    stderr: rebaseStderr(input.stderr, input.hosts),
    base: input.base,
    commit: input.message,
  };
}

function conflictMarkers(file: string): boolean {
  try {
    const text = readFileSync(file, 'utf8');
    return text.includes('<<<<<<<') && text.includes('>>>>>>>');
  } catch {
    return false;
  }
}

/** `--no-skip-worktree` is ignored when `--no-assume-unchanged` is in the same call. */
async function resetHard(cwd: string, repo: string, hosts: RebaseHosts, rev: string): Promise<void> {
  const raw = await gitRawAt(cwd, repo, ['ls-files', '-z']);
  if (raw.length > 0) {
    await gitStdin(cwd, repo, hosts, ['update-index', '--no-skip-worktree', '-z', '--stdin'], raw);
    await gitStdin(cwd, repo, hosts, ['update-index', '--no-assume-unchanged', '-z', '--stdin'], raw);
  }
  await gitAt(cwd, repo, ['reset', '--hard', rev], 'rebase failed', hosts);
}

async function readRebaseState(cwd: string, repo: string): Promise<RebaseState | null> {
  const target = await resolveGitPath(cwd, 'swarmloop-rebase');
  if (!target || !existsSync(target)) {
    return null;
  }
  const text = readFileSync(target, 'utf8');
  const split = text.indexOf('\n');
  if (split < 0) {
    throw new SwarmloopError(`${repo} rebase failed: swarmloop-rebase`);
  }
  const baseSha = text.slice(0, split).trim();
  let message = text.slice(split + 1);
  if (message.endsWith('\n')) {
    message = message.slice(0, -1);
  }
  if (message.endsWith('\r')) {
    message = message.slice(0, -1);
  }
  if (!baseSha) {
    throw new SwarmloopError(`${repo} rebase failed: swarmloop-rebase`);
  }
  return { baseSha, message };
}

async function baseRefFor(cwd: string, prompt: string | null, sha: string): Promise<string> {
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

async function cloneUnmerged(tmp: string, repo: string, hosts: RebaseHosts): Promise<string[]> {
  let raw = '';
  try {
    raw = await gitRaw(cloneArgs(tmp, ['diff', '--name-only', '--diff-filter=U', '-z']));
  } catch (error) {
    if (!gitMissing(error)) {
      throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
    }
  }
  return raw.split('\0').map((item) => item.trim()).filter((item) => item.length > 0);
}

async function indexDirty(tmp: string, repo: string, hosts: RebaseHosts): Promise<boolean> {
  try {
    await git(cloneArgs(tmp, ['diff', '--cached', '--quiet']));
    return false;
  } catch (error) {
    if (gitMissing(error)) {
      return true;
    }
    throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
  }
}

async function tipInBase(tmp: string, tipSha: string, baseSha: string, repo: string, hosts: RebaseHosts): Promise<boolean> {
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

async function cloneAuthor(cwd: string): Promise<string[]> {
  const flags = await authorArgs(cwd);
  if (flags.length > 0) {
    return flags;
  }
  const name = await localConfig(cwd, 'user.name');
  const email = await localConfig(cwd, 'user.email');
  const args: string[] = [];
  if (name) {
    args.push('-c', `user.name=${name}`);
  }
  if (email) {
    args.push('-c', `user.email=${email}`);
  }
  return args;
}

async function localConfig(cwd: string, key: string): Promise<string> {
  try {
    return await git(['-C', cwd, 'config', '--local', '--get', key]);
  } catch {
    return '';
  }
}

function cloneArgs(tmp: string, args: string[]): string[] {
  return ['-C', tmp, '-c', 'safe.directory=*', ...args];
}

/** The main repository, so a linked worktree is not what `git clone --shared` opens. */
async function cloneSource(cwd: string): Promise<string> {
  let common = '';
  try {
    common = await git(['-C', cwd, 'rev-parse', '--git-common-dir']);
  } catch {
    return cwd;
  }
  if (!isAbsolute(common)) {
    common = join(cwd, common);
  }
  const parent = dirname(common);
  if (common.endsWith(`${sep}.git`) && existsSync(parent)) {
    return parent;
  }
  return cwd;
}

type CopiedFile = { kind: 'file'; bytes: Buffer } | { kind: 'link'; target: string };

function readCloneFiles(tmp: string, paths: string[]): Map<string, CopiedFile> {
  const files = new Map<string, CopiedFile>();
  for (const path of new Set(paths)) {
    const full = join(tmp, path);
    try {
      const info = lstatSync(full);
      if (info.isSymbolicLink()) {
        files.set(path, { kind: 'link', target: readlinkSync(full) });
        continue;
      }
      if (info.isFile()) {
        files.set(path, { kind: 'file', bytes: readFileSync(full) });
      }
    } catch {
      // The clone path is absent.
    }
  }
  return files;
}

/** Parents stay inside the worktree. A directory symlink is replaced, not followed. */
function copiedDestination(cwd: string, rel: string): string {
  const parts = rel.split('/').filter((part) => part.length > 0);
  let dir = cwd;
  for (let index = 0; index < parts.length - 1; index += 1) {
    dir = join(dir, parts[index] ?? '');
    replaceLinkedDirectory(dir);
  }
  const leaf = parts[parts.length - 1];
  return leaf ? join(dir, leaf) : cwd;
}

function replaceLinkedDirectory(full: string): void {
  try {
    const info = lstatSync(full);
    if (info.isDirectory()) {
      return;
    }
    unlinkSync(full);
  } catch {
    // The parent is absent.
  }
  mkdirSync(full);
}

/** Unlink a file or symlink. `unlink` does not follow a link. */
function removeCopiedPath(full: string): void {
  try {
    const info = lstatSync(full);
    if (info.isSymbolicLink() || info.isFile()) {
      unlinkSync(full);
    }
  } catch {
    // The path is absent.
  }
}

async function importCloneBlobs(cwd: string, tmp: string, repo: string, hosts: RebaseHosts, entries: StageEntry[]): Promise<void> {
  const shas = [...new Set(entries.filter((entry) => entry.mode !== '160000' && entry.sha !== EMPTY_BLOB).map((entry) => entry.sha))];
  if (shas.length === 0) {
    return;
  }
  let report = '';
  try {
    report = await gitRaw(['-C', cwd, 'cat-file', '--batch-check'], undefined, `${shas.join('\n')}\n`);
  } catch (error) {
    throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
  }
  const missing = report.split('\n').flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.endsWith(' missing')) {
      return [];
    }
    const sha = trimmed.slice(0, -' missing'.length).trim();
    return sha ? [sha] : [];
  });
  for (const sha of missing) {
    try {
      const body = await gitRaw(cloneArgs(tmp, ['cat-file', 'blob', sha]));
      await gitRaw(['-C', cwd, 'hash-object', '-w', '--stdin'], undefined, body);
    } catch (error) {
      throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
    }
  }
}

async function loadCloneIndex(
  cwd: string,
  repo: string,
  hosts: RebaseHosts,
  entries: StageEntry[],
  removed: string[],
): Promise<void> {
  const lines: string[] = [];
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!paths.has(entry.path)) {
      lines.push(`0 ${EMPTY_BLOB} 0\t${entry.path}`);
      paths.add(entry.path);
    }
    lines.push(`${entry.mode} ${entry.sha} ${entry.stage}\t${entry.path}`);
  }
  for (const path of removed) {
    lines.push(`0 ${EMPTY_BLOB} 0\t${path}`);
  }
  if (lines.length === 0) {
    return;
  }
  await gitStdin(cwd, repo, hosts, ['update-index', '--index-info'], `${lines.join('\n')}\n`);
}

function parseStageList(raw: string): StageEntry[] {
  const entries: StageEntry[] = [];
  for (const record of raw.split('\0')) {
    if (!record) {
      continue;
    }
    const tab = record.indexOf('\t');
    if (tab <= 0) {
      continue;
    }
    const meta = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (meta.length < 3 || !path) {
      continue;
    }
    entries.push({ mode: meta[0] ?? '', sha: meta[1] ?? '', stage: meta[2] ?? '0', path });
  }
  return entries;
}

async function gitStdin(cwd: string, repo: string, hosts: RebaseHosts, args: string[], input: string): Promise<void> {
  try {
    await gitRaw(['-C', cwd, ...args], undefined, input);
  } catch (error) {
    throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
  }
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

/** Per-worktree ref for the files this run hides during rebase. */
const HIDDEN_REF = 'refs/worktree/swarmloop-rebase';

function hiddenMessage(paths: string[]): string {
  return `swarmloop-rebase\n${paths.join('\n')}\n`;
}

function hiddenPaths(message: string): string[] {
  const lines = message.split('\n');
  if ((lines[0] ?? '').trim() !== 'swarmloop-rebase') {
    return [];
  }
  return lines.slice(1).filter((line) => line.length > 0);
}

async function restoreHiddenWorktree(cwd: string, repo: string, hosts: RebaseHosts, captured: string): Promise<void> {
  try {
    await git(['-C', cwd, 'rev-parse', '--verify', '--quiet', HIDDEN_REF]);
  } catch (error) {
    if (gitMissing(error)) {
      return;
    }
    throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts, captured)}`);
  }
  const message = await gitAt(cwd, repo, ['log', '-1', '--format=%B', HIDDEN_REF], 'rebase failed', hosts, captured);
  let paths = hiddenPaths(message);
  const present = (await gitRaw(['-C', cwd, 'ls-tree', '-r', '--name-only', '-z', HIDDEN_REF])).split('\0').filter((item) => item.length > 0);
  if (paths.length === 0) {
    paths = present;
  }
  const known = new Set(present);
  const checkout = paths.filter((path) => known.has(path));
  const removed = paths.filter((path) => !known.has(path));
  if (checkout.length > 0) {
    await gitAt(cwd, repo, ['restore', '--source', HIDDEN_REF, '--worktree', '--', ...checkout], 'rebase failed', hosts, captured);
  }
  for (const path of removed) {
    removeCopiedPath(join(cwd, path));
  }
  await gitAt(cwd, repo, ['update-ref', '-d', HIDDEN_REF], 'rebase failed', hosts, captured);
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
  const held = deniedIndexPaths(porcelain, denied);
  if (held.length > 0) {
    await gitAt(cwd, repo, ['reset', '-q', 'HEAD', '--', ...held], 'commit failed');
  }
  const selection = stageSelection(porcelain, denied);
  if (selection.add.length > 0) {
    await gitAt(cwd, repo, ['add', '--', ...selection.add], 'commit failed');
  }
  if (selection.add.length === 0 && selection.staged.length === 0) {
    return;
  }
  await gitAt(cwd, repo, [...(await authorArgs(cwd)), 'commit', '--no-verify', '-m', message], 'commit failed');
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

async function hideDeniedWorktree(cwd: string, repo: string, denied: string[], hosts: RebaseHosts): Promise<void> {
  const dirty = deniedInWorktree(await gitRawAt(cwd, repo, ['status', '--porcelain=v1', '-z', '-uall']), denied);
  if (dirty.length === 0) {
    return;
  }
  const scratch = await mkdtemp(join(tmpdir(), 'swarmloop-hide-'));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    await git(['-C', cwd, 'read-tree', '--empty'], env);
    const present = dirty.filter((path) => worktreeFile(join(cwd, path)));
    if (present.length > 0) {
      await git(['-C', cwd, 'update-index', '--add', '--', ...present], env);
    }
    const tree = await git(['-C', cwd, 'write-tree'], env);
    const commit = await git(['-C', cwd, 'commit-tree', tree, '-m', hiddenMessage(dirty)], env);
    await gitAt(cwd, repo, ['update-ref', HIDDEN_REF, commit], 'rebase failed', hosts, '');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  try {
    await gitAt(cwd, repo, ['checkout', 'HEAD', '--', ...dirty], 'rebase failed', hosts, '');
  } catch (error) {
    try {
      await restoreHiddenWorktree(cwd, repo, hosts, '');
    } catch {
      // The ref still holds this run's files.
    }
    throw error;
  }
}

function worktreeFile(full: string): boolean {
  try {
    const info = lstatSync(full);
    return info.isFile() || info.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function storedBase(
  cwd: string,
  repo: string,
  prompt: string | null,
  hosts: RebaseHosts,
  step: 'prepare' | 'rebase',
): Promise<string> {
  const wanted = promptBase(prompt);
  const origin = await originUrl(cwd, repo, `${step} failed`);
  if (!origin) {
    if (wanted.kind === 'named') {
      throw new SwarmloopError(`${repo} has no ${originRef(wanted.name)}`);
    }
    return 'HEAD';
  }
  const names = wanted.kind === 'named' ? [wanted.name] : ['main', 'master'];
  for (const name of names) {
    if (await fetchSource(cwd, repo, origin, name, hosts, step)) {
      return originRef(name);
    }
  }
  const missing = wanted.kind === 'named' ? originRef(wanted.name) : 'origin/master';
  throw new SwarmloopError(`${repo} has no ${missing}`);
}

const checkoutFetches = new Map<string, Promise<void>>();

/** First attempt, then at most three retries when git reports `cannot lock ref`. */
const FETCH_LOCK_ATTEMPTS = 4;

function withCheckoutLock<T>(checkout: string, run: () => Promise<T>): Promise<T> {
  const previous = checkoutFetches.get(checkout) ?? Promise.resolve();
  const current = previous.then(run, run);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  checkoutFetches.set(checkout, settled);
  void settled.then(() => {
    if (checkoutFetches.get(checkout) === settled) {
      checkoutFetches.delete(checkout);
    }
  });
  return current;
}

/** Fetch one source branch. One fetch runs at a time per checkout. A missing ref tries the next candidate. A ref lock is retried. Any other fetch failure stops the step. */
async function fetchSource(
  cwd: string,
  repo: string,
  origin: string,
  name: string,
  hosts: RebaseHosts,
  step: 'prepare' | 'rebase',
): Promise<boolean> {
  const gitlab = gitlabPushUrl(origin, hosts.GITLAB_BASE_URL, hosts.GITLAB_TOKEN);
  const url = gitlab ?? githubPushUrl(origin, hosts.GITHUB_BASE_URL, hosts.GITHUB_TOKEN);
  const refspec = `+refs/heads/${name}:refs/remotes/origin/${name}`;
  const secret = gitlab ? hosts.GITLAB_TOKEN : hosts.GITHUB_TOKEN;
  if (!url && (origin.startsWith('git@') || origin.startsWith('ssh://'))) {
    throw new SwarmloopError(sshFailure(repo, origin, hosts, step));
  }
  const checkout = await cloneSource(cwd);
  return withCheckoutLock(checkout, () => fetchLocked(cwd, repo, url, refspec, name, secret, step));
}

async function fetchLocked(
  cwd: string,
  repo: string,
  url: string | null,
  refspec: string,
  name: string,
  secret: string,
  step: 'prepare' | 'rebase',
): Promise<boolean> {
  for (let attempt = 0; attempt < FETCH_LOCK_ATTEMPTS; attempt += 1) {
    try {
      if (url) {
        await git(['-C', cwd, 'fetch', url, refspec], { GIT_TERMINAL_PROMPT: '0' });
        await clearFetchedToken(cwd, name, secret);
      } else {
        await git(['-C', cwd, 'fetch', 'origin', refspec], { GIT_TERMINAL_PROMPT: '0' });
      }
      return true;
    } catch (error) {
      if (error instanceof SwarmloopError) {
        throw error;
      }
      const detail = redact(gitDetail(error), secret.trim());
      if (detail.includes("couldn't find remote ref")) {
        return false;
      }
      if (detail.includes('cannot lock ref') && attempt < FETCH_LOCK_ATTEMPTS - 1) {
        continue;
      }
      throw new SwarmloopError(`${repo} ${step} failed: ${detail}`);
    }
  }
  throw new SwarmloopError(`${repo} ${step} failed`);
}

function sshFailure(repo: string, origin: string, hosts: RebaseHosts, step: 'prepare' | 'rebase'): string {
  const name = codeHostFromOrigin(origin, hosts.GITLAB_BASE_URL, hosts.GITHUB_BASE_URL);
  if (!name) {
    return `${repo} ${step} failed: code host is missing`;
  }
  const host = selectedHost(hosts, name);
  if (!host.token.trim()) {
    return `${repo} ${step} failed: ${host.tokenKey} is missing`;
  }
  if (!host.baseUrl.trim()) {
    return `${repo} ${step} failed: ${host.baseKey} is missing`;
  }
  return `${repo} ${step} failed: origin is not ${host.baseKey}`;
}

/** The fetch URL stays in FETCH_HEAD and the remote-tracking reflog. Drop the token from both. */
async function clearFetchedToken(cwd: string, branch: string, secret: string): Promise<void> {
  if (!secret.trim()) {
    return;
  }
  for (const name of ['FETCH_HEAD', `logs/refs/remotes/origin/${branch}`]) {
    const target = await resolveGitPath(cwd, name);
    if (!target || !existsSync(target)) {
      continue;
    }
    const text = readFileSync(target, 'utf8');
    const cleaned = redact(text, secret.trim());
    if (cleaned !== text) {
      writeFileSync(target, cleaned);
    }
  }
}

/** Full git stderr for a rebase failure, with both host tokens removed. A captured rebase stderr wins over a later command. */
function rebaseStderr(text: string, hosts: RebaseHosts, captured = ''): string {
  const body = captured.trim() ? captured : text;
  return redact(redact(body, hosts.GITLAB_TOKEN.trim()), hosts.GITHUB_TOKEN.trim());
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

async function gitAt(cwd: string, repo: string, args: string[], failure: string, hosts?: RebaseHosts, captured = ''): Promise<string> {
  try {
    return await git(['-C', cwd, ...args]);
  } catch (error) {
    const detail = failure === 'rebase failed' && hosts ? rebaseStderr(gitStderr(error), hosts, captured) : gitDetail(error);
    throw new SwarmloopError(`${repo} ${failure}: ${detail}`);
  }
}

async function gitRawAt(cwd: string, repo: string, args: string[]): Promise<string> {
  try {
    return await gitRaw(['-C', cwd, ...args]);
  } catch (error) {
    throw new SwarmloopError(`${repo} status failed: ${gitDetail(error)}`);
  }
}
