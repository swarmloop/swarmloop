import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function changedFiles(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  let base = 'HEAD';
  try {
    base = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // A fresh local clone may not have a remote-tracking base yet.
  }
  return [
    ...new Set([
      ...git(['diff', '--name-only', '--diff-filter=ACMR', '-z', base]),
      ...git(['ls-files', '--others', '--exclude-standard', '-z']),
    ]),
  ];
}

/** Repository-specific checks for the feature diff, including uncommitted and new files. */
export function checkWorktree(root) {
  const files = changedFiles(root);
  const typescript = files.filter((file) => /\.tsx?$/.test(file));
  if (typescript.length) {
    execFileSync(
      process.execPath,
      [join(root, 'node_modules/eslint/bin/eslint.js'), '-c', 'eslint.strict.config.mjs', '--', ...typescript],
      { cwd: root, stdio: 'inherit' },
    );
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
    checkWorktree(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  } catch (error) {
    if (typeof error.status !== 'number') throw error;
    process.exitCode = error.status || 1;
  }
}
