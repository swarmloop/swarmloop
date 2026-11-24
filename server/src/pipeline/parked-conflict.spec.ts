import type { DocumentRepository } from '../history/document.repository';
import { parkedConflict, parkedConflictIn, readParkedConflict } from './parked-conflict';

function journalOf(checkpoint: string, generation: number): string {
  return JSON.stringify({ app: { path: '/w', branch: 'b', checkpoint, generation } });
}

describe('parkedConflict', () => {
  it('is true for pending-implement with a conflict of the same generation', () => {
    expect(
      parkedConflict({ marker: 'pending-implement\nunfinished', journal: journalOf('conflict', 2), generation: 2 }),
    ).toBe(true);
  });

  it('is true for pending', () => {
    expect(parkedConflict({ marker: ' pending \n', journal: journalOf('conflict', 2), generation: 2 })).toBe(true);
  });

  it('is false for a recreated worktree: checkpoint applying and no marker', () => {
    expect(parkedConflict({ marker: null, journal: journalOf('applying', 2), generation: 2 })).toBe(false);
  });

  it.each(['review', 'clear', ''])('is false for the marker %j', (marker) => {
    expect(parkedConflict({ marker, journal: journalOf('conflict', 2), generation: 2 })).toBe(false);
  });

  it('is false for an entry of an older generation or no journal', () => {
    expect(parkedConflict({ marker: 'pending', journal: journalOf('conflict', 1), generation: 2 })).toBe(false);
    expect(parkedConflict({ marker: 'pending', journal: null, generation: 2 })).toBe(false);
  });
});

describe('parkedConflictIn and readParkedConflict', () => {
  it('reads the latest body of each kind from the list', () => {
    const documents = [
      { kind: 'rebase_conflict', body: 'clear' },
      { kind: 'rebase_journal', body: journalOf('applying', 3) },
      { kind: 'rebase_conflict', body: 'pending-implement' },
      { kind: 'rebase_journal', body: journalOf('conflict', 3) },
    ];
    expect(parkedConflictIn(documents, { generation: 3 })).toBe(true);
    expect(parkedConflictIn(documents.slice(0, 2), { generation: 3 })).toBe(false);
  });

  it('reads the bodies from the repository by the run key', async () => {
    const bodies: Record<string, string> = { rebase_conflict: 'pending', rebase_journal: journalOf('conflict', 1) };
    const documents = {
      latestBody: (key: string, kind: string) => Promise.resolve(key === 'run-a' ? bodies[kind] : null),
    };
    expect(await readParkedConflict(documents as unknown as DocumentRepository, { key: 'run-a', generation: 1 })).toBe(
      true,
    );
    expect(await readParkedConflict(documents as unknown as DocumentRepository, { key: 'run-b', generation: 1 })).toBe(
      false,
    );
  });
});
