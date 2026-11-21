import { lchown, lstat, readdir, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import type { SandboxMount } from '../core/sandbox-mount';

/** Reuses a hand-over until Git rewrites the index, the directory is replaced, or the container user changes. */
export class SandboxOwnership {
  private readonly completed = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string[]>>();

  constructor(private readonly hand: typeof handToSandbox = handToSandbox) {}

  async prepare(mounts: SandboxMount[], uid: number): Promise<string[]> {
    const handed: string[] = [];
    for (const mount of mounts) {
      if (!mount.readonly && mount.volumeSubpath) {
        handed.push(...(await this.prepareTree(mount.hostPath, uid)));
      }
    }
    return handed;
  }

  private async prepareTree(path: string, uid: number): Promise<string[]> {
    while (this.pending.has(path)) {
      await this.pending.get(path);
    }
    const work = this.handIfChanged(path, uid);
    this.pending.set(path, work);
    try {
      return await work;
    } finally {
      this.pending.delete(path);
    }
  }

  private async handIfChanged(path: string, uid: number): Promise<string[]> {
    const stamp = await ownershipStamp(path, uid);
    if (this.completed.get(path) === stamp) {
      return [];
    }
    const handed = await this.hand(path, uid);
    this.completed.set(path, await ownershipStamp(path, uid));
    return handed;
  }
}

/** The index is replaced by checkout/reset/rebase, including when HEAD does not change. No dependency traversal. */
async function ownershipStamp(path: string, uid: number): Promise<string> {
  const root = await lstat(path);
  let gitDir = join(path, '.git');
  try {
    if (!(await lstat(gitDir)).isDirectory()) {
      const pointer = await readFile(gitDir, 'utf8');
      gitDir = resolve(path, pointer.replace(/^gitdir:\s*/, '').trim());
    }
    const index = await lstat(join(gitDir, 'index'));
    return `${uid}:${root.dev}:${root.ino}:${root.uid}:${index.ino}:${index.ctimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return `${uid}:${root.dev}:${root.ino}:${root.uid}:${root.ctimeMs}`;
  }
}

type Hand = (path: string, uid: number, gid: number) => Promise<void>;

/**
 * Gives every entry of the tree that the uid does not own to that uid, so a container running as it can write.
 * Symlinks are handed over but never followed. Returns the paths it handed over.
 */
export async function handToSandbox(path: string, uid: number, hand: Hand = lchown): Promise<string[]> {
  const handed: string[] = [];
  await walk(path, uid, hand, handed);
  return handed;
}

async function walk(path: string, uid: number, hand: Hand, handed: string[]): Promise<void> {
  const stat = await lstat(path);
  if (stat.uid !== uid) {
    await hand(path, uid, uid);
    handed.push(path);
  }
  if (stat.isDirectory()) {
    for (const name of await readdir(path)) {
      await walk(join(path, name), uid, hand, handed);
    }
  }
}
