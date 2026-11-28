import { readFileSync } from 'fs';
import { join } from 'path';
import { CODE_REVIEWERS } from '../../contract/steps';
import type { DocumentRepository } from '../../history/document.repository';
import {
  composedReturn,
  handoffSection,
  handoffText,
  issueOf,
  latestReturnedNotes,
  mergeHandoff,
  recordHandoff,
  returnNotes,
  withDecision,
  withHandoff,
} from './handoff';

describe('issueOf', () => {
  it('gives the same problem from the same source the same id', () => {
    expect(issueOf('pipeline', 'one title', 'log\n').id).toBe(issueOf('pipeline', 'another title', 'log\n').id);
    expect(issueOf('pipeline', 't', 'log\n').id).toMatch(/^pipeline-[0-9a-f]{10}$/);
  });

  it('gives another source or another body another id', () => {
    const base = issueOf('pipeline', 't', 'log\n').id;
    expect(issueOf('quality', 't', 'log\n').id).not.toBe(base);
    expect(issueOf('pipeline', 't', 'other\n').id).not.toBe(base);
  });
});

describe('composedReturn', () => {
  const issues = [issueOf('quality', 't', 'fix it\n')];

  it('prefers the stored return, then the latest issues', () => {
    const stored = { kind: 'return', body: 'report\n' };
    const listed = { kind: 'issues', body: JSON.stringify(issues) };
    expect(composedReturn([listed, stored])).toBe('report\n');
    expect(composedReturn([listed])).toBe(returnNotes(issues).body);
  });

  it('falls back to the reviews of a run from before issues', () => {
    const documents = [
      { kind: 'review_quality', body: 'decision: return\n' },
      { kind: 'review_security', body: 'decision: ok\n' },
    ];
    expect(composedReturn(documents)).toBe('## quality\ndecision: return\n');
    expect(composedReturn([])).toBeNull();
  });

  it('takes the decision of a review from its stored result, not from the text of the document', () => {
    const result = (decision: string) => JSON.stringify({ decision, review: 'notes', summary: [] });
    const documents = [
      { kind: 'review_quality', body: 'notes\ndecision: ok\n' },
      { kind: 'review_quality_result', body: result('return') },
      { kind: 'review_security', body: 'notes\ndecision: return\n' },
      { kind: 'review_security_result', body: result('ok') },
    ];
    expect(composedReturn(documents)).toBe('## quality\nnotes\ndecision: ok\n');
  });

  it('hands on a finding of the retired quality reviewer, but not once the three reviewers reviewed after it', () => {
    const retired = [
      { id: 1, kind: 'review_quality', body: 'notes\ndecision: return\n' },
      { id: 2, kind: 'review_quality_result', body: JSON.stringify({ decision: 'return', review: 'n', summary: [] }) },
    ];
    expect(composedReturn(retired)).toBe('## quality\nnotes\ndecision: return\n');
    const sections = { quality: 'checked', security: 'checked' };
    const code = [
      { id: 4, kind: 'review_code', body: 'fine\ndecision: ok\n' },
      {
        id: 5,
        kind: 'review_code_result',
        body: JSON.stringify({ decision: 'ok', review: 'f', summary: [], sections }),
      },
    ];
    expect(composedReturn([...code, ...retired])).toBeNull();
  });

  it('holds no reviewer name literal', () => {
    const source = readFileSync(join(__dirname, 'handoff.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function composedReturn'));
    for (const reviewer of CODE_REVIEWERS) {
      expect(body).not.toContain(`'${reviewer}'`);
    }
  });
});

describe('latestReturnedNotes', () => {
  const quality = { id: 1, kind: 'review_quality', body: 'notes\ndecision: return\n' };
  const code = { id: 2, kind: 'review_code', body: 'fine\ndecision: ok\n' };
  const repository = (stored: { id: number; kind: string; body: string }[]): DocumentRepository =>
    ({
      latestDocuments: async (_runs: number[], kinds: string[]) =>
        stored.filter((document) => kinds.includes(document.kind)),
    }) as unknown as DocumentRepository;

  it('reads the finding of a retired reviewer from the newest document of its kind', async () => {
    expect(await latestReturnedNotes(repository([quality]), 1)).toBe('## quality\nnotes\ndecision: return\n');
  });

  it('does not hand on the stale return of a retired reviewer after the three reviewers reviewed', async () => {
    expect(await latestReturnedNotes(repository([code, quality]), 1)).toBeNull();
  });
});

describe('handoff storage', () => {
  it('stores JSON and renders the same ## <step> text', () => {
    const stored = mergeHandoff(mergeHandoff(null, 'plan', '- a\n'), 'implement', '- b');
    expect(JSON.parse(stored)).toEqual([
      { step: 'plan', body: '- a' },
      { step: 'implement', body: '- b' },
    ]);
    expect(handoffText(stored)).toBe('## plan\n- a\n\n## implement\n- b\n');
    expect(withHandoff([], stored)).toEqual([
      { heading: 'What previous steps did', body: '## plan\n- a\n\n## implement\n- b\n' },
    ]);
    expect(handoffSection(stored, 'implement')).toBe('- b');
    expect(handoffSection(stored, 'research')).toBe('');
  });

  it('replaces the entry of a step in place', () => {
    const stored = mergeHandoff(mergeHandoff(mergeHandoff(null, 'a', '1'), 'b', '2'), 'a', '3');
    expect(JSON.parse(stored)).toEqual([
      { step: 'a', body: '3' },
      { step: 'b', body: '2' },
    ]);
  });

  it('reads a Markdown handoff and keeps its sections when merged', () => {
    const old = '## plan\n- add the field\n\n## implement\n- changed it\n';
    expect(handoffSection(old, 'plan')).toBe('- add the field');
    expect(handoffText(old)).toBe(old);
    expect(JSON.parse(mergeHandoff(old, 'code-review', '- ok'))).toEqual([
      { step: 'plan', body: '- add the field' },
      { step: 'implement', body: '- changed it' },
      { step: 'code-review', body: '- ok' },
    ]);
  });

  it('adds no section for a null, empty or blank handoff', () => {
    for (const empty of [null, '', '  \n']) {
      expect(withHandoff([], empty)).toEqual([]);
      expect(handoffSection(empty, 'plan')).toBe('');
    }
  });

  it('stores a body with headings, colons, code and quotes whole', () => {
    const body = '- said "go": a: b\n```ts\nconst x = 1;\n```\n  ## not a step';
    const stored = mergeHandoff(null, 'implement', body);
    expect(handoffSection(stored, 'implement')).toBe(body);
    expect(handoffSection(mergeHandoff(stored, 'plan', '- x'), 'implement')).toBe(body);
  });

  it('records a handoff draft whose body is JSON', async () => {
    const documents = { latestBody: async () => null } as unknown as DocumentRepository;
    const draft = await recordHandoff(documents, 'K', 'plan', '- a');
    expect(draft.kind).toBe('handoff');
    expect(JSON.parse(draft.body)).toEqual([{ step: 'plan', body: '- a' }]);
  });
});

describe('withDecision', () => {
  it('writes the time after the task id when one is given, and leaves it out when not', () => {
    const timed = withDecision('- x', 'a', 'first\nsecond', '2026-11-19T10:00:00.000Z');
    expect(timed).toBe('- x\n\ndecisions:\n- subtask a at 2026-11-19T10:00:00.000Z: first\n  second\n');
    expect(withDecision(timed, 'b', 'plain')).toBe(`${timed}- subtask b: plain\n`);
  });
});
