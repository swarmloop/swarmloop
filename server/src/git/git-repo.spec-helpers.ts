import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { gitOutput } from '../testing/git-fixture';

/** Runs git with no background upkeep: a detached `gc --auto` after a commit rewrites `.git/objects` while a spec copies the repository. */
export function runGit(repo: string, args: string[]): string {
  const config = ['user.name=t', 'user.email=t@example.com', 'gc.auto=0', 'maintenance.auto=false'];
  return gitOutput(repo, ['-C', repo, ...config.flatMap((entry) => ['-c', entry]), ...args]);
}

export function writeFiles(repo: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
}

/** A temporary repository on branch main with one commit holding the files. */
export function makeRepo(files: Record<string, string> = { 'README.md': 'x\n' }): string {
  const repo = mkdtempSync(join(tmpdir(), 'swarmloop-repo-'));
  runGit(repo, ['init', '-q', '-b', 'main']);
  commitFiles(repo, files);
  return repo;
}

export function commitFiles(repo: string, files: Record<string, string>): void {
  writeFiles(repo, files);
  runGit(repo, ['add', '-A']);
  runGit(repo, ['commit', '-q', '-m', 'files']);
}
