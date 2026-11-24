import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { gitUnrecorded } from './git';

const DELETED = '\u0000deleted';
const LS_TREE_CHUNK = 200;

interface DiskEntry {
  mode: string;
  bytes: Buffer;
}

interface HeadEntry {
  mode: string;
  blob: string;
}

/** Read-only calls only: no index refresh, no optional lock, no external driver (names only), no rename detection. */
function read(path: string, args: string[]): Promise<string> {
  return gitUnrecorded(['-C', path, '--no-optional-locks', '--literal-pathspecs', ...args]);
}

function names(output: string): string[] {
  return output.split('\0').filter((name) => name.length > 0);
}

/** True when the repository has a head commit. Without one, the base is the empty tree: every indexed path is new. */
function hasHead(path: string): Promise<boolean> {
  return read(path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).then(
    () => true,
    () => false,
  );
}

const OUTSIDE: DiskEntry = { mode: 'outside', bytes: Buffer.alloc(0) };
const SPECIAL: DiskEntry = { mode: 'special', bytes: Buffer.alloc(0) };

/** True when the real folder of the file lies inside the real worktree, so no linked folder leads out of it. */
async function staysInside(root: string, file: string): Promise<boolean> {
  const [base, folder] = await Promise.all([realpath(root), realpath(dirname(file)).catch(() => null)]);
  return folder !== null && (folder === base || folder.startsWith(base + sep));
}

/**
 * The file on disk as git would store it: a link by its target text (never followed), a folder or submodule by its mode
 * only. A path whose real folder is outside the worktree, or that is neither a regular file, a link nor a folder (a FIFO,
 * a device), is marked by its kind and never opened.
 */
async function diskEntry(path: string, name: string): Promise<DiskEntry | null> {
  const file = join(path, name);
  if (!(await staysInside(path, file))) return OUTSIDE;
  const info = await lstat(file).catch(() => null);
  if (!info) return null;
  if (info.isSymbolicLink()) return { mode: '120000', bytes: Buffer.from(await readlink(file)) };
  if (info.isDirectory()) return { mode: '160000', bytes: Buffer.alloc(0) };
  if (!info.isFile()) return SPECIAL;
  return { mode: info.mode & 0o111 ? '100755' : '100644', bytes: await readFile(file) };
}

function blobId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** The entries the head commit holds at these paths. */
async function headEntries(path: string, headed: boolean, tracked: string[]): Promise<Map<string, HeadEntry>> {
  const entries = new Map<string, HeadEntry>();
  if (!headed) return entries;
  for (let from = 0; from < tracked.length; from += LS_TREE_CHUNK) {
    const out = await read(path, ['ls-tree', '-z', '-r', 'HEAD', '--', ...tracked.slice(from, from + LS_TREE_CHUNK)]);
    for (const record of names(out)) {
      const tab = record.indexOf('\t');
      const [mode, , blob] = record.slice(0, tab).split(' ');
      entries.set(record.slice(tab + 1), { mode, blob });
    }
  }
  return entries;
}

/**
 * A fingerprint of the uncommitted changes of a worktree: every tracked path that differs from the head commit and every
 * new file that is not ignored, each by its mode and bytes read from disk (a fixed mark when it is gone), in sorted path
 * order. Git only lists the paths. Nothing is written to the repository and no command span is recorded. A path git lists
 * only because it was touched, with the content and mode of the head, is left out.
 */
export async function changeFingerprint(worktreePath: string): Promise<string> {
  const headed = await hasHead(worktreePath);
  const [diffed, untracked] = await Promise.all([
    read(
      worktreePath,
      headed ? ['diff-index', '--name-only', '--relative', '--no-renames', '-z', 'HEAD'] : ['ls-files', '-z'],
    ),
    read(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const tracked = names(diffed);
  const head = await headEntries(worktreePath, headed, tracked);
  const hash = createHash('sha256');
  for (const name of [...new Set([...tracked, ...names(untracked)])].sort()) {
    const disk = await diskEntry(worktreePath, name);
    const before = head.get(name);
    if (disk && before && disk.mode === before.mode && disk.mode !== '160000' && blobId(disk.bytes) === before.blob) {
      continue;
    }
    hash.update(`${name}\0`);
    if (!disk) {
      hash.update(DELETED);
    } else {
      hash.update(`${disk.mode}\0${disk.bytes.length}\0`).update(disk.bytes);
    }
    hash.update('\n');
  }
  return hash.digest('hex');
}
