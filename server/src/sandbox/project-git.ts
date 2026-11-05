import { execFile } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import type { SandboxMount } from '../core/sandbox-mount';

/** Portable, read-only Git metadata. A worktree's .git file points outside the sandbox. */
export async function projectGitMount(mount: SandboxMount, directory: string): Promise<SandboxMount[]> {
  if (!existsSync(join(mount.hostPath, '.git'))) {
    return [];
  }
  const snapshot = mkdtempSync(join(directory, 'git-'));
  try {
    await runGit(['clone', '--mirror', '--no-hardlinks', '--quiet', '--', mount.hostPath, snapshot]);
    // Do not pass remotes, credentials, hooks or host-specific config into the sandbox.
    writeFileSync(
      join(snapshot, 'config'),
      '[core]\nrepositoryformatversion = 0\nbare = false\nhooksPath = /dev/null\n',
    );
    await runGit(['--git-dir', snapshot, 'read-tree', 'HEAD']);
    chmodSync(snapshot, 0o755);
    const target = `${mount.containerPath}/.git`;
    if (statSync(join(mount.hostPath, '.git')).isDirectory()) {
      return [{ hostPath: snapshot, containerPath: target, readonly: true }];
    }
    // Docker cannot mount a directory over a linked worktree's .git file.
    const containerPath = `/swarmloop-git/${basename(snapshot)}`;
    const pointer = join(snapshot, 'worktree-link');
    writeFileSync(pointer, `gitdir: ${containerPath}\n`);
    return [
      { hostPath: snapshot, containerPath, readonly: true },
      { hostPath: pointer, containerPath: target, readonly: true },
    ];
  } catch (error) {
    rmSync(snapshot, { recursive: true, force: true });
    throw error;
  }
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve();
    });
  });
}
