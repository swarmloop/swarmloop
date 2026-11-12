import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintAddedLines } from './lint-added-lines.mjs';

/** The merge base with origin/main, or HEAD in a fresh clone that has no remote-tracking base yet. */
function baseOf(root) {
  try {
    return execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'HEAD';
  }
}

export function changedFiles(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const base = baseOf(root);
  return [
    ...new Set([
      ...git(['diff', '--name-only', '--diff-filter=ACMR', '-z', base]),
      ...git(['ls-files', '--others', '--exclude-standard', '-z']),
    ]),
  ];
}

/** Repository-specific checks for the feature diff, including uncommitted and new files. */
export async function checkWorktree(root) {
  const files = changedFiles(root);
  const typescript = files.filter((file) => /\.tsx?$/.test(file));
  if (typescript.length) {
    const { kept, report } = await lintAddedLines({ root, base: baseOf(root), files: typescript });
    process.stdout.write(report);
    if (kept.length) throw Object.assign(new Error('lint failed'), { status: 1 });
  }
  if (files.length) {
    execFileSync(
      process.execPath,
      [join(root, 'node_modules/prettier/bin/prettier.cjs'), '--check', '--ignore-unknown', '--', ...files],
      { cwd: root, stdio: 'inherit' },
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await checkWorktree(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  } catch (error) {
    if (typeof error.status !== 'number') throw error;
    process.exitCode = error.status || 1;
  }
}
