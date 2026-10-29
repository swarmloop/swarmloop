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
});

function commit(repo: string, message: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-m', message]);
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
