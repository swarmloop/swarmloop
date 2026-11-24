import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { runInStepScope } from '../core/step-event-scope';
import type { StepEvent } from '../contract/step-events';
import { git } from '../testing/git-fixture';
import { changeFingerprint } from './change-fingerprint';

describe('changeFingerprint', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'change-fingerprint-'));
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 'dev@example.com']);
    git(repo, ['config', 'user.name', 'Dev']);
    writeFileSync(join(repo, 'kept.txt'), 'one\n');
    writeFileSync(join(repo, 'run.sh'), 'echo\n');
    writeFileSync(join(repo, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'one']);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('gives a new value for a fix left uncommitted and the same value for the same tree', async () => {
    const clean = await changeFingerprint(repo);
    writeFileSync(join(repo, 'kept.txt'), 'two\n');
    const fixed = await changeFingerprint(repo);
    expect(fixed).not.toBe(clean);
    expect(await changeFingerprint(repo)).toBe(fixed);
  });

  it('gives a new value for an uncommitted edit of a binary file', async () => {
    const clean = await changeFingerprint(repo);
    writeFileSync(join(repo, 'image.bin'), Buffer.from([0, 1, 2, 4]));
    const first = await changeFingerprint(repo);
    expect(first).not.toBe(clean);
    writeFileSync(join(repo, 'image.bin'), Buffer.from([0, 1, 2, 5]));
    expect(await changeFingerprint(repo)).not.toBe(first);
  });

  it('gives a new value for a deleted tracked file and for a mode-only change', async () => {
    const clean = await changeFingerprint(repo);
    chmodSync(join(repo, 'run.sh'), 0o755);
    const mode = await changeFingerprint(repo);
    expect(mode).not.toBe(clean);
    rmSync(join(repo, 'kept.txt'));
    expect(await changeFingerprint(repo)).not.toBe(mode);
  });

  it('is not changed by an external diff driver or textconv of the repository', async () => {
    writeFileSync(join(repo, 'kept.txt'), 'two\n');
    const plain = await changeFingerprint(repo);
    writeFileSync(join(repo, '.gitattributes'), '*.txt diff=odd\n');
    git(repo, ['config', 'diff.odd.command', 'false']);
    git(repo, ['config', 'diff.odd.textconv', 'false']);
    git(repo, ['config', 'diff.renames', 'true']);
    const withAttributes = await changeFingerprint(repo);
    git(repo, ['config', '--unset', 'diff.odd.command']);
    git(repo, ['config', '--unset', 'diff.odd.textconv']);
    expect(await changeFingerprint(repo)).toBe(withAttributes);
    // .gitattributes is itself a new file, so only the driver settings are compared with it in place.
    expect(withAttributes).not.toBe(plain);
  });

  it('gives the same value for a touched file with no content change, and leaves the index as it was', async () => {
    const clean = await changeFingerprint(repo);
    const index = readFileSync(join(repo, '.git', 'index'));
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(repo, 'kept.txt'), later, later);
    writeFileSync(join(repo, 'kept.txt'), 'one\n');
    expect(await changeFingerprint(repo)).toBe(clean);
    expect(readFileSync(join(repo, '.git', 'index')).equals(index)).toBe(true);
  });

  it('counts a new file and leaves an ignored one out', async () => {
    const clean = await changeFingerprint(repo);
    writeFileSync(join(repo, 'ignored.txt'), 'x\n');
    expect(await changeFingerprint(repo)).toBe(clean);
    writeFileSync(join(repo, 'new.txt'), 'x\n');
    expect(await changeFingerprint(repo)).not.toBe(clean);
  });

  it('reads a repository with no commit yet, and a checkout that is a folder of a repository', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'change-fingerprint-empty-'));
    try {
      git(empty, ['init', '-b', 'main']);
      const none = await changeFingerprint(empty);
      writeFileSync(join(empty, 'a.txt'), 'a\n');
      expect(await changeFingerprint(empty)).not.toBe(none);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const folder = join(repo, 'sub');
    mkdirSync(folder);
    writeFileSync(join(folder, 'in.txt'), '1\n');
    git(repo, ['add', 'sub/in.txt']);
    git(repo, ['commit', '-m', 'sub']);
    const clean = await changeFingerprint(folder);
    writeFileSync(join(folder, 'in.txt'), '2\n');
    expect(await changeFingerprint(folder)).not.toBe(clean);
  });

  it('writes nothing to the repository', async () => {
    writeFileSync(join(repo, 'kept.txt'), 'two\n');
    writeFileSync(join(repo, 'new.txt'), 'x\n');
    const snapshot = () => ({
      objects: git(repo, ['count-objects', '-v']),
      refs: git(repo, ['for-each-ref']),
      index: readFileSync(join(repo, '.git', 'index')).toString('hex'),
      status: git(repo, ['--no-optional-locks', 'status', '--porcelain']),
      work: readFileSync(join(repo, 'kept.txt'), 'utf8'),
    });
    const before = snapshot();
    await changeFingerprint(repo);
    expect(snapshot()).toEqual(before);
  });

  it('records no command span', async () => {
    writeFileSync(join(repo, 'kept.txt'), 'two\n');
    const events: StepEvent[] = [];
    const sink = (event: StepEvent) => {
      events.push(event);
      return Promise.resolve();
    };
    await runInStepScope(
      { runId: 1, attemptId: 'attempt-1', step: 'code-review', root: repo, clock: new FakeClock(), sink },
      0,
      () => changeFingerprint(repo),
    );
    expect(events).toEqual([]);
  });
});
