import { lchown, lstat, readdir } from 'fs/promises';
import { join } from 'path';

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
