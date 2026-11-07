import 'reflect-metadata';

import { writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ERROR_CODES } from '../../contract/error-codes';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { SwarmloopError } from '../../core/swarmloop-error';
import { featureWorktree, git } from '../../testing/runs.spec-helpers';
import { resetHard } from './conflict';
import { completeRebase, fingerprintOf, parseJournal, protectRef, unfinished } from './journal';
import type { JournalEntry } from './journal';
import { memoryJournal } from './journal.spec-helpers';

const hosts = { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '', clock: new FakeClock() };

async function entryFor(tree: string, branch: string, patch: Partial<JournalEntry> = {}): Promise<JournalEntry> {
  return {
    path: tree,
    branch,
    oldHead: git(tree, ['rev-parse', 'HEAD']),
    fingerprint: await fingerprintOf(tree),
    protectRef: protectRef(branch),
    expectedRemoteTip: null,
    baseSha: git(tree, ['rev-parse', 'origin/main']),
    checkpoint: 'applying',
    generation: 0,
    ...patch,
  };
}

describe('rebase journal', () => {
  it('resets only to a SHA the journal holds, while the files are those it recorded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-journal-reset-'));
    const { tree } = featureWorktree(root, 'proj-95');
    const branch = 'feature/proj-95-ship-the-field';
    const journal = memoryJournal();
    const entry = await entryFor(tree, branch);
    await journal.put('demo', entry);
    writeFileSync(join(tree, 'src', 'extra.ts'), 'export const extra = 1;\n');
    await expect(resetHard(tree, 'demo', hosts, journal, 'baseSha')).rejects.toMatchObject({
      code: ERROR_CODES.REBASE_CONFLICT,
      message: expect.stringContaining('demo'),
    });
    expect(git(tree, ['status', '--porcelain'])).toContain('extra.ts');
    await journal.advance('demo', 'applying', { fingerprint: await fingerprintOf(tree) });
    await expect(resetHard(tree, 'demo', hosts, journal, 'squashSha')).rejects.toBeInstanceOf(SwarmloopError);
    await resetHard(tree, 'demo', hosts, journal, 'baseSha');
    expect(git(tree, ['rev-parse', 'HEAD'])).toBe(entry.baseSha);
  });

  it('keeps the fingerprint when the same files are committed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-journal-fingerprint-'));
    const { tree } = featureWorktree(root, 'proj-96');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    const before = await fingerprintOf(tree);
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'field']);
    expect(await fingerprintOf(tree)).toBe(before);
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 2;\n');
    expect(await fingerprintOf(tree)).not.toBe(before);
  });

  it('completes the repos that applied and leaves a repo in conflict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-journal-complete-'));
    const { tree } = featureWorktree(root, 'proj-97');
    const branch = 'feature/proj-97-ship-the-field';
    const journal = memoryJournal();
    await journal.put('demo', await entryFor(tree, branch, { checkpoint: 'applied' }));
    await journal.put('web', await entryFor(tree, branch, { checkpoint: 'conflict' }));
    expect(unfinished(await journal.read())).toBe(true);
    await completeRebase(journal);
    const stored = parseJournal(JSON.stringify(await journal.read()));
    expect(stored.demo?.checkpoint).toBe('completed');
    expect(stored.web?.checkpoint).toBe('conflict');
    expect(await journal.open()).toEqual(stored);
  });
});
