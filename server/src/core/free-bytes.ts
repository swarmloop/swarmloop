import { execFile } from 'child_process';
import { statfs } from 'fs/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
/** `df -P` columns: filesystem, 1024-blocks, used, available, capacity. The name may hold spaces, the numbers never do. */
const DF_LINE = /(\d+)\s+(\d+)\s+(\d+)\s+\d+%/;

/** The free kilobytes in the last line of `df -Pk`, or null when it cannot be read. */
export function dfAvailableBytes(output: string): number | null {
  const match = DF_LINE.exec(output.trim().split('\n').at(-1) ?? '');
  return match ? Number(match[3]) * 1024 : null;
}

/**
 * Free bytes as `df` counts them. Node's statfs multiplies the free blocks by the optimal transfer size, not by the
 * block size: on Docker Desktop's shared folders that is 1 MiB against 4 KiB blocks, 256 times too much.
 */
export async function freeBytes(path: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('df', ['-Pk', path]);
    const bytes = dfAvailableBytes(stdout);
    if (bytes !== null) {
      return bytes;
    }
  } catch {
    // No df: fall back to statfs, right wherever the transfer size equals the block size.
  }
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}
