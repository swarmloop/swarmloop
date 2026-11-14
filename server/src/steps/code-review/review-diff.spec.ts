import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REVIEW_DIFF_PATH, reviewDiffSection, writeReviewDiff } from './review-diff';

describe('review diff', () => {
  it('uses the branch diff when the worktree is clean', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-review-diff-clean-'));
    const repo = join(root, 'app');
    git(root, ['init', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README'), 'base\n');
    commit(repo, 'base');
    git(root, ['init', '--bare', join(root, 'app.git')]);
    git(repo, ['remote', 'add', 'origin', join(root, 'app.git')]);
    git(repo, ['push', '-u', 'origin', 'main']);
    git(repo, ['checkout', '-b', 'feature/field']);
    writeFileSync(join(repo, 'Field.php'), '<?php\n');
    commit(repo, 'field');

    const section = await reviewDiffSection([{ hostPath: repo, containerPath: '/work/app', readonly: true }]);

    expect(section.heading).toBe('Diff');
    expect(section.body).toContain(REVIEW_DIFF_PATH);
    expect(section.body).toContain('Clean worktree');
    expect(section.body).toContain('origin/main');
    expect(section.body).toContain('Field.php');
    expect(section.body).not.toContain('<?php');
    expect(section.patch).toContain('<?php');
  });

  it('diffs a clean worktree against the branch the prompt names, not against the default branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-review-diff-named-'));
    const repo = join(root, 'app');
    git(root, ['init', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README'), 'base\n');
    commit(repo, 'base');
    git(root, ['init', '--bare', join(root, 'app.git')]);
    git(repo, ['remote', 'add', 'origin', join(root, 'app.git')]);
    git(repo, ['push', '-u', 'origin', 'main']);
    git(repo, ['checkout', '-b', 'feature/parent']);
    writeFileSync(join(repo, 'Sibling.php'), '<?php // other subtask\n');
    commit(repo, 'sibling');
    git(repo, ['push', '-u', 'origin', 'feature/parent']);
    git(repo, ['checkout', '-b', 'feature/parent-t1']);
    writeFileSync(join(repo, 'Own.php'), '<?php // this subtask\n');
    commit(repo, 'own');
    const mounts = [{ hostPath: repo, containerPath: '/work/app', readonly: true }];

    const named = await reviewDiffSection(mounts, [], 'task\nbranch: feature/parent\n');
    const fallback = await reviewDiffSection(mounts);

    expect(named.body).toContain('origin/feature/parent');
    expect(named.body).toContain('Own.php');
    expect(named.body).not.toContain('Sibling.php');
    expect(named.patch).not.toContain('other subtask');
    expect(fallback.body).toContain('Sibling.php');
  });

  it('reviews the replayed commits when the only leftover file is denied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-review-diff-denied-'));
    const repo = join(root, 'app');
    git(root, ['init', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README'), 'base\n');
    commit(repo, 'base');
    git(root, ['init', '--bare', join(root, 'app.git')]);
    git(repo, ['remote', 'add', 'origin', join(root, 'app.git')]);
    git(repo, ['push', '-u', 'origin', 'main']);
    git(repo, ['checkout', '-b', 'feature/field']);
    writeFileSync(join(repo, 'Field.php'), '<?php\n');
    commit(repo, 'field');
    writeFileSync(join(repo, '.env'), 'TOKEN=secret\n');

    const section = await reviewDiffSection([{ hostPath: repo, containerPath: '/work/app', readonly: true }], ['.env']);

    expect(section.body).toContain('Clean worktree');
    expect(section.body).toContain('origin/main');
    expect(section.body).toContain('Field.php');
    expect(section.body).not.toContain('.env');
    expect(section.patch).toContain('<?php');
    expect(section.patch).not.toContain('TOKEN=secret');
  });

  it('omits a denied leftover when another file is also uncommitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-review-diff-denied-mixed-'));
    const repo = join(root, 'app');
    git(root, ['init', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README'), 'base\n');
    commit(repo, 'base');
    git(root, ['init', '--bare', join(root, 'app.git')]);
    git(repo, ['remote', 'add', 'origin', join(root, 'app.git')]);
    git(repo, ['push', '-u', 'origin', 'main']);
    writeFileSync(join(repo, 'README'), 'changed\n');
    writeFileSync(join(repo, '.env'), 'TOKEN=secret\n');

    const section = await reviewDiffSection([{ hostPath: repo, containerPath: '/work/app', readonly: true }], ['.env']);

    expect(section.body).toContain('Uncommitted changes against HEAD');
    expect(section.body).toContain('README');
    expect(section.body).not.toContain('.env');
    expect(section.patch).toContain('+changed');
    expect(section.patch).not.toContain('TOKEN=secret');
  });

  it('uses uncommitted changes when the worktree is dirty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-review-diff-dirty-'));
    const repo = join(root, 'app');
    git(root, ['init', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README'), 'base\n');
    commit(repo, 'base');
    git(root, ['init', '--bare', join(root, 'app.git')]);
    git(repo, ['remote', 'add', 'origin', join(root, 'app.git')]);
    git(repo, ['push', '-u', 'origin', 'main']);
    writeFileSync(join(repo, 'README'), 'changed\n');
    writeFileSync(join(repo, 'New.php'), '<?php\n');

    const section = await reviewDiffSection([{ hostPath: repo, containerPath: '/work/app', readonly: true }]);

    expect(section.body).toContain('Uncommitted changes against HEAD');
    expect(section.body).toContain('README');
    expect(section.body).toContain('New.php');
    expect(section.body).not.toContain('+changed');
    expect(section.patch).toContain('+changed');
    expect(section.patch).toContain('New.php');
    expect(section.body).not.toContain('Clean worktree');
  });

  it('keeps a large document in the diff file and names it in the prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-review-diff-large-'));
    const repo = join(root, 'app');
    git(root, ['init', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README'), 'base\n');
    commit(repo, 'base');
    git(root, ['init', '--bare', join(root, 'app.git')]);
    git(repo, ['remote', 'add', 'origin', join(root, 'app.git')]);
    git(repo, ['push', '-u', 'origin', 'main']);
    git(repo, ['checkout', '-b', 'feature/field']);
    mkdirSync(join(repo, 'lib'));
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'lib', 'Field.php'), '<?php\necho 1;\n');
    writeFileSync(join(repo, 'docs', 'plan.md'), 'plan '.repeat(20_000));
    commit(repo, 'field');

    const section = await reviewDiffSection([{ hostPath: repo, containerPath: '/work/app', readonly: true }]);
    const file = writeReviewDiff(root, 'PROJ-1', section.patch);

    expect(section.body).toContain('lib/Field.php');
    expect(section.body).toContain('docs/plan.md');
    expect(section.body).not.toContain('echo 1');
    expect(section.body).not.toContain('plan '.repeat(50));
    expect(readFileSync(file, 'utf8')).toContain('echo 1');
    expect(readFileSync(file, 'utf8')).toContain('plan '.repeat(50));
  });

  it('names a test file and keeps its body in the diff file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-review-diff-test-'));
    const repo = join(root, 'app');
    git(root, ['init', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README'), 'base\n');
    commit(repo, 'base');
    git(root, ['init', '--bare', join(root, 'app.git')]);
    git(repo, ['remote', 'add', 'origin', join(root, 'app.git')]);
    git(repo, ['push', '-u', 'origin', 'main']);
    git(repo, ['checkout', '-b', 'feature/field']);
    mkdirSync(join(repo, 'lib'));
    mkdirSync(join(repo, 'tests'));
    writeFileSync(join(repo, 'lib', 'Field.php'), '<?php\necho 1;\n');
    writeFileSync(join(repo, 'tests', 'FieldTest.php'), '<?php\nTESTBODY\n');
    commit(repo, 'field');

    const section = await reviewDiffSection([{ hostPath: repo, containerPath: '/work/app', readonly: true }]);
    const file = writeReviewDiff(root, 'PROJ-1', section.patch);

    expect(section.body).toContain('lib/Field.php');
    expect(section.body).toContain('tests/FieldTest.php');
    expect(section.body).not.toContain('TESTBODY');
    expect(readFileSync(file, 'utf8')).toContain('TESTBODY');
    expect(readFileSync(file, 'utf8')).toContain('echo 1');
  });

  it('keeps every source file in the diff file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-review-diff-cap-'));
    const repo = join(root, 'app');
    git(root, ['init', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README'), 'base\n');
    commit(repo, 'base');
    git(root, ['init', '--bare', join(root, 'app.git')]);
    git(repo, ['remote', 'add', 'origin', join(root, 'app.git')]);
    git(repo, ['push', '-u', 'origin', 'main']);
    git(repo, ['checkout', '-b', 'feature/field']);
    mkdirSync(join(repo, 'lib'));
    writeFileSync(join(repo, 'lib', 'a.php'), `alpha-marker\n${'A'.repeat(30_000)}`);
    writeFileSync(join(repo, 'lib', 'b.php'), `bravo-marker\n${'B'.repeat(30_000)}`);
    writeFileSync(join(repo, 'lib', 'c.php'), `charlie-marker\n${'C'.repeat(30_000)}`);
    commit(repo, 'field');

    const section = await reviewDiffSection([{ hostPath: repo, containerPath: '/work/app', readonly: true }]);
    const file = writeReviewDiff(root, 'PROJ-1', section.patch);
    const stored = readFileSync(file, 'utf8');

    expect(section.body).toContain('lib/a.php');
    expect(section.body).toContain('lib/b.php');
    expect(section.body).toContain('lib/c.php');
    expect(section.body).not.toContain('alpha-marker');
    expect(section.body).not.toContain('charlie-marker');
    expect(stored).toContain('alpha-marker');
    expect(stored).toContain('bravo-marker');
    expect(stored).toContain('charlie-marker');
  });

  it('reviews the commits, the uncommitted edits and the new files together', async () => {
    const repo = featureRepo('swarmloop-review-diff-whole-');
    writeFileSync(join(repo, 'security.ts'), 'export const SECURITY = 1;\n');
    commit(repo, 'security');
    writeFileSync(join(repo, 'README'), 'changed\n');
    writeFileSync(join(repo, 'Extra.php'), '<?php // extra\n');

    const section = await reviewDiffSection([{ hostPath: repo, containerPath: '/work/app', readonly: true }]);

    expect(section.body).toContain('origin/main');
    expect(section.body).toContain('security.ts');
    expect(section.body).toContain('README');
    expect(section.body).toContain('Extra.php');
    expect(section.body).not.toContain('SECURITY = 1');
    expect(section.body).not.toContain('+changed');
    expect(section.patch).toContain('SECURITY = 1');
    expect(section.patch).toContain('+changed');
    expect(section.patch).toContain('// extra');
  });

  it('reviews an epic parent with its merged subtasks and its own edit', async () => {
    const repo = featureRepo('swarmloop-review-diff-epic-', 'feature/epic');
    for (const [branch, file] of [
      ['feature/epic-t1', 'One.php'],
      ['feature/epic-t2', 'Two.php'],
    ]) {
      git(repo, ['checkout', '-b', branch, 'feature/epic']);
      writeFileSync(join(repo, file), `<?php // ${file}\n`);
      commit(repo, file);
      git(repo, ['checkout', 'feature/epic']);
      git(repo, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'merge', '--no-ff', branch, '-m', branch]);
    }
    writeFileSync(join(repo, 'README'), 'parent edit\n');

    const section = await reviewDiffSection([{ hostPath: repo, containerPath: '/work/app', readonly: true }]);

    for (const name of ['One.php', 'Two.php', 'README']) {
      expect(section.body).toContain(name);
    }
    expect(section.patch).toContain('// One.php');
    expect(section.patch).toContain('// Two.php');
    expect(section.patch).toContain('+parent edit');
  });

  it('gives a clean worktree the same diff as the branch diff', async () => {
    const repo = featureRepo('swarmloop-review-diff-same-');
    writeFileSync(join(repo, 'Field.php'), '<?php\n');
    commit(repo, 'field');
    const log = execFileSync('git', ['log', '--oneline', 'origin/main...HEAD'], { cwd: repo, encoding: 'utf8' });
    const diff = execFileSync('git', ['diff', 'origin/main...HEAD'], { cwd: repo, encoding: 'utf8' });

    const section = await reviewDiffSection([{ hostPath: repo, containerPath: '/work/app', readonly: true }]);

    expect(section.patch).toBe(
      `## app\nClean worktree. Commits on HEAD that are not in origin/main.\n${log.trim()}\n\n${diff.trimEnd()}\n`,
    );
  });

  it('changes the review patch when only a commit of the branch changes', async () => {
    const repo = featureRepo('swarmloop-review-diff-amend-');
    writeFileSync(join(repo, 'security.ts'), 'export const SECURITY = 1;\n');
    commit(repo, 'security');
    writeFileSync(join(repo, 'README'), 'changed\n');
    const mounts = [{ hostPath: repo, containerPath: '/work/app', readonly: true }];
    const first = await reviewDiffSection(mounts);

    writeFileSync(join(repo, 'security.ts'), 'export const SECURITY = 2;\n');
    git(repo, ['add', 'security.ts']);
    git(repo, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '--amend', '--no-edit']);
    const second = await reviewDiffSection(mounts);

    expect(second.patch).not.toBe(first.patch);
    expect(second.patch).toContain('SECURITY = 2');
  });
});

/** A checkout on a feature branch off a pushed main. */
function featureRepo(prefix: string, branch = 'feature/field'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repo = join(root, 'app');
  git(root, ['init', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README'), 'base\n');
  commit(repo, 'base');
  git(root, ['init', '--bare', join(root, 'app.git')]);
  git(repo, ['remote', 'add', 'origin', join(root, 'app.git')]);
  git(repo, ['push', '-u', 'origin', 'main']);
  git(repo, ['checkout', '-b', branch]);
  return repo;
}

function commit(repo: string, message: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-m', message]);
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
