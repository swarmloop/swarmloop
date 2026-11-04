import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, unlinkSync } from 'fs';
import { dirname, isAbsolute, join, sep } from 'path';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git, gitMissing, gitRaw, gitStderr, authorArgs } from '../git';
import type { RebaseHosts } from './rebase';
import { rebaseStderr } from './rebase';

const EMPTY_BLOB = '0000000000000000000000000000000000000000';
interface StageEntry {
  mode: string;
  sha: string;
  stage: string;
  path: string;
}
type CopiedFile = { kind: 'file'; bytes: Buffer } | { kind: 'link'; target: string };

export async function cloneUnmerged(tmp: string, repo: string, hosts: RebaseHosts): Promise<string[]> {
  let raw = '';
  try {
    raw = await gitRaw(cloneArgs(tmp, ['ls-files', '-u', '-z']));
  } catch (error) {
    if (!gitMissing(error)) throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
  }
  return unmergedFromStageList(raw);
}

/** The main repository, so a linked worktree is not what `git clone --shared` opens. */
export async function cloneSource(cwd: string): Promise<string> {
  let common = '';
  try {
    common = await git(['-C', cwd, 'rev-parse', '--git-common-dir']);
  } catch {
    return cwd;
  }
  if (!isAbsolute(common)) common = join(cwd, common);
  const parent = dirname(common);
  if (common.endsWith(`${sep}.git`) && existsSync(parent)) return parent;
  return cwd;
}

export async function cloneAuthor(cwd: string): Promise<string[]> {
  const flags = await authorArgs(cwd);
  if (flags.length > 0) return flags;
  const name = await localConfig(cwd, 'user.name');
  const email = await localConfig(cwd, 'user.email');
  const args: string[] = [];
  if (name) args.push('-c', `user.name=${name}`);
  if (email) args.push('-c', `user.email=${email}`);
  return args;
}
export async function localConfig(cwd: string, key: string): Promise<string> {
  try {
    return await git(['-C', cwd, 'config', '--local', '--get', key]);
  } catch {
    return '';
  }
}
export function cloneArgs(tmp: string, args: string[]): string[] {
  return ['-C', tmp, '-c', 'safe.directory=*', ...args];
}

export function readCloneFiles(tmp: string, paths: string[]): Map<string, CopiedFile> {
  const files = new Map<string, CopiedFile>();
  for (const path of new Set(paths))
    try {
      const info = lstatSync(join(tmp, path));
      if (info.isSymbolicLink()) files.set(path, { kind: 'link', target: readlinkSync(join(tmp, path)) });
      else if (info.isFile()) files.set(path, { kind: 'file', bytes: readFileSync(join(tmp, path)) });
    } catch {
      /* The clone path is absent. */
    }
  return files;
}
export async function importCloneBlobs(
  cwd: string,
  tmp: string,
  repo: string,
  hosts: RebaseHosts,
  entries: StageEntry[],
): Promise<void> {
  const shas = [
    ...new Set(
      entries.filter((entry) => entry.mode !== '160000' && entry.sha !== EMPTY_BLOB).map((entry) => entry.sha),
    ),
  ];
  if (shas.length === 0) return;
  let report = '';
  try {
    report = await gitRaw(['-C', cwd, 'cat-file', '--batch-check'], undefined, `${shas.join('\n')}\n`);
  } catch (error) {
    throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
  }
  const missing = report.split('\n').flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.endsWith(' missing')) return [];
    const sha = trimmed.slice(0, -' missing'.length).trim();
    return sha ? [sha] : [];
  });
  for (const sha of missing)
    try {
      const body = await gitRaw(cloneArgs(tmp, ['cat-file', 'blob', sha]));
      await gitRaw(['-C', cwd, 'hash-object', '-w', '--stdin'], undefined, body);
    } catch (error) {
      throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
    }
}
export async function loadCloneIndex(
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
  for (const path of removed) lines.push(`0 ${EMPTY_BLOB} 0\t${path}`);
  if (lines.length === 0) return;
  await gitStdin(cwd, repo, hosts, ['update-index', '--index-info'], `${lines.join('\n')}\n`);
}
export function parseStageList(raw: string): StageEntry[] {
  const entries: StageEntry[] = [];
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab <= 0) continue;
    const meta = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (meta.length < 3 || !path) continue;
    entries.push({ mode: meta[0] ?? '', sha: meta[1] ?? '', stage: meta[2] ?? '0', path });
  }
  return entries;
}
export function unmergedFromStageList(raw: string): string[] {
  const paths: string[] = [];
  for (const entry of parseStageList(raw))
    if (entry.stage !== '0' && !paths.includes(entry.path)) paths.push(entry.path);
  return paths;
}
export async function indexDirty(tmp: string, repo: string, hosts: RebaseHosts): Promise<boolean> {
  try {
    await git(cloneArgs(tmp, ['diff', '--cached', '--quiet']));
    return false;
  } catch (error) {
    if (gitMissing(error)) return true;
    throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
  }
}
export async function gitStdin(
  cwd: string,
  repo: string,
  hosts: RebaseHosts,
  args: string[],
  input: string,
): Promise<void> {
  try {
    await gitRaw(['-C', cwd, ...args], undefined, input);
  } catch (error) {
    throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
  }
}
export function copiedDestination(cwd: string, rel: string): string {
  const parts = rel.split('/').filter((part) => part.length > 0);
  let dir = cwd;
  for (let index = 0; index < parts.length - 1; index += 1) {
    dir = join(dir, parts[index] ?? '');
    replaceLinkedDirectory(dir);
  }
  const leaf = parts[parts.length - 1];
  return leaf ? join(dir, leaf) : cwd;
}
export function replaceLinkedDirectory(full: string): void {
  try {
    if (lstatSync(full).isDirectory()) return;
    unlinkSync(full);
  } catch {
    /* The parent is absent. */
  }
  mkdirSync(full);
}
/** Unlink a file or symlink. `unlink` does not follow a link. */
export function removeCopiedPath(full: string): void {
  try {
    const info = lstatSync(full);
    if (info.isSymbolicLink() || info.isFile()) unlinkSync(full);
  } catch {
    /* The path is absent. */
  }
}
