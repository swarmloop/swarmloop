// Measures what opening a step costs on a checkout: the snapshot (`git add -A` into a temporary index)
// with an empty index (before) and with an index seeded from the worktree's own (after), and the fetch of origin.
// Usage: node scripts/measure-step-open.mjs <checkout> [branch]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function git(repo, args, env = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

function timed(run) {
  const start = process.hrtime.bigint();
  const value = run();
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, value };
}

function snapshot(repo, seed) {
  const dir = mkdtempSync(join(tmpdir(), 'measure-index-'));
  const index = join(dir, 'index');
  try {
    if (seed) {
      const own = resolve(repo, git(repo, ['rev-parse', '--git-path', 'index']).trim());
      if (existsSync(own)) {
        copyFileSync(own, index);
      }
    }
    return timed(() => {
      git(repo, ['add', '-A'], { GIT_INDEX_FILE: index });
      return git(repo, ['write-tree'], { GIT_INDEX_FILE: index }).trim();
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function measure(repo, branch = 'main') {
  const before = snapshot(repo, false);
  const after = snapshot(repo, true);
  let fetchMs = null;
  try {
    fetchMs = timed(() =>
      git(repo, ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
        GIT_TERMINAL_PROMPT: '0',
      }),
    ).ms;
  } catch {
    fetchMs = null;
  }
  return {
    snapshotBeforeMs: Math.round(before.ms),
    snapshotAfterMs: Math.round(after.ms),
    fetchMs: fetchMs === null ? null : Math.round(fetchMs),
    sameTree: before.value === after.value,
    tree: after.value,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/measure-step-open.mjs <checkout> [branch]');
    process.exit(2);
  }
  const result = measure(isAbsolute(target) ? target : resolve(target), process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
  if (!result.sameTree) {
    process.exit(1);
  }
}
