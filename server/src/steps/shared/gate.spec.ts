import { countsFor } from '../../history/gate-stamp';
import { DocumentRepository } from '../../history/document.repository';
import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { gateCounts, stampGate, worktreesFingerprint } from './gate';

describe('countsFor', () => {
  const run = { generation: 2 };

  it('counts only when the generation and the fingerprint both match', () => {
    expect(countsFor(run, { generation: 2, fingerprint: 'a' }, 'a')).toBe(true);
    expect(countsFor(run, { generation: 1, fingerprint: 'a' }, 'a')).toBe(false);
    expect(countsFor(run, { generation: 2, fingerprint: 'a' }, 'b')).toBe(false);
  });

  it('does not count a gate without a stamp, or with half of one', () => {
    expect(countsFor(run, null, 'a')).toBe(false);
    expect(countsFor(run, undefined, 'a')).toBe(false);
    expect(countsFor(run, { fingerprint: 'a' }, 'a')).toBe(false);
    expect(countsFor(run, { generation: 2 }, 'a')).toBe(false);
  });
});

describe('gate stamps on documents', () => {
  it('counts a stamped document for its generation and files, and for nothing else', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const documents = db.app.get(DocumentRepository);
      const run = await runs.begin('run-1', 'code-review');
      await documents.putDocument(run, 'review_quality', 'notes\ndecision: ok\n');
      expect(await gateCounts(documents, run, 'review_quality', 'files')).toBe(false);
      await stampGate(documents, run, 'review_quality', 'files');
      expect(await gateCounts(documents, run, 'review_quality', 'files')).toBe(true);
      expect(await gateCounts(documents, run, 'review_quality', 'other files')).toBe(false);
      await documents.putDocument(run, 'review_quality', 'notes\ndecision: return\n');
      expect(await gateCounts(documents, run, 'review_quality', 'files')).toBe(false);
      await stampGate(documents, run, 'review_quality', 'files');
      await runs.bumpGeneration('run-1');
      const next = (await runs.findRun('run-1'))!;
      expect(next.generation).toBe(run.generation + 1);
      expect(await gateCounts(documents, next, 'review_quality', 'files')).toBe(false);
    } finally {
      await db.close();
    }
  });

  it('keeps one order of the worktrees whoever asks', async () => {
    expect(await worktreesFingerprint(['/nowhere/b', '/nowhere/a'])).toBe(
      await worktreesFingerprint(['/nowhere/a', '/nowhere/b']),
    );
  });
});
