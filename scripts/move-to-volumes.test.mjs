import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = join(import.meta.dirname, 'move-to-volumes.sh');
const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' });

// Every path, mode and content under a folder, to show the old folders did not change.
function snapshot(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return `${path}:${entry.isFile() ? readFileSync(path, 'utf8') : ''}:${statSync(path).mode}`;
    })
    .sort();
}

// Paths that stand for /checkouts and /app/worktrees hold a clone with a locked worktree and a table-only repository;
// they are then moved aside as the old host folders and the volume paths are left empty.
function installation() {
  const base = mkdtempSync(join(tmpdir(), 'swarmloop-move-'));
  const checkouts = join(base, 'checkouts');
  const worktrees = join(base, 'worktrees');
  const origin = join(base, 'origin.git');
  mkdirSync(checkouts);
  mkdirSync(join(worktrees, 'run1'), { recursive: true });
  git(base, 'init', '-q', '--bare', origin);
  git(base, 'clone', '-q', origin, join(checkouts, 'demo'));
  writeFileSync(join(checkouts, 'demo', 'a.txt'), 'one\n');
  git(join(checkouts, 'demo'), 'add', '.');
  git(join(checkouts, 'demo'), 'commit', '-qm', 'first');
  git(join(checkouts, 'demo'), 'worktree', 'add', '-q', '--lock', '-b', 'run1', join(worktrees, 'run1', 'demo'));
  git(base, 'clone', '-q', origin, join(checkouts, 'tableonly'));
  writeFileSync(join(checkouts, 'tableonly', 'b.txt'), 'two\n');
  git(join(checkouts, 'tableonly'), 'add', '.');
  git(join(checkouts, 'tableonly'), 'commit', '-qm', 'second');
  rmSync(join(checkouts, 'demo', 'a.txt'));
  const data = join(base, 'data');
  mkdirSync(data);
  const db = new DatabaseSync(join(data, 'swarmloop.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE checkouts (id integer PRIMARY KEY, name varchar NOT NULL, path text NOT NULL)');
  db.prepare('INSERT INTO checkouts (name, path) VALUES (?, ?)').run('tableonly', '/checkouts/tableonly');
  db.close();
  chmodSync(data, 0o555);
  const old = join(base, 'old');
  mkdirSync(old);
  renameSync(checkouts, join(old, 'checkouts'));
  renameSync(worktrees, join(old, 'worktrees'));
  mkdirSync(checkouts);
  mkdirSync(worktrees);
  return { base, checkouts, worktrees, old, data };
}

function runInside(site) {
  const result = spawnSync('bash', [script, 'inside'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OLD_WORKTREES: join(site.old, 'worktrees'),
      OLD_CHECKOUTS: join(site.old, 'checkouts'),
      OLD_DATA: site.data,
      WORKTREES: site.worktrees,
      CHECKOUTS: site.checkouts,
      HOST_CHECKOUTS_ROOT: '/host/code',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('copies worktrees and clones into the volumes, leaves the old folders alone and prints the cleanup commands', () => {
  const site = installation();
  try {
    const before = [snapshot(join(site.old, 'worktrees')), snapshot(join(site.old, 'checkouts')), snapshot(site.data)];
    const output = runInside(site);
    const worktree = join(site.worktrees, 'run1', 'demo');

    assert.match(git(worktree, 'status', '--short'), /^$/);
    assert.match(git(worktree, 'log', '--oneline'), /first/);
    assert.equal(
      readFileSync(join(worktree, '.git'), 'utf8').trim(),
      `gitdir: ${site.checkouts}/demo/.git/worktrees/demo`,
    );
    assert.ok(existsSync(join(site.checkouts, 'tableonly', '.git')));
    assert.equal(readFileSync(join(site.checkouts, 'demo', 'a.txt'), 'utf8'), 'one\n');
    assert.equal(readFileSync(join(site.checkouts, 'tableonly', 'b.txt'), 'utf8'), 'two\n');
    assert.deepEqual(
      [snapshot(join(site.old, 'worktrees')), snapshot(join(site.old, 'checkouts')), snapshot(site.data)],
      before,
    );

    assert.match(output, /Copied run folder run1/);
    assert.match(output, /Copied repository demo/);
    assert.match(output, /Copied repository tableonly/);
    assert.match(output, /host folders are left/);
    assert.ok(output.includes(`git -C /host/code/demo worktree unlock ${worktree}`));
    assert.ok(output.includes('git -C /host/code/demo worktree prune'));
    assert.ok(output.includes('git -C /host/code/tableonly worktree prune'));
    assert.ok(!output.includes('/host/code/tableonly worktree unlock'));
  } finally {
    chmodSync(site.data, 0o755);
    rmSync(site.base, { recursive: true, force: true });
  }
});

test('skips and reports a repository that is already in the volume', () => {
  const site = installation();
  try {
    cpSync(join(site.old, 'checkouts', 'tableonly'), join(site.checkouts, 'tableonly'), { recursive: true });
    const output = runInside(site);
    assert.match(output, /Skipped repository tableonly: it is already in the volume/);
    assert.match(output, /Copied repository demo/);
  } finally {
    chmodSync(site.data, 0o755);
    rmSync(site.base, { recursive: true, force: true });
  }
});
