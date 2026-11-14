import { readFileSync } from 'fs';
import { join } from 'path';
import { CODE_REVIEWERS } from '../../contract/steps';
import type { DocumentRepository } from '../../history/document.repository';
import {
  composedReturn,
  handoffSection,
  handoffText,
  issueOf,
  mergeHandoff,
  recordHandoff,
  returnNotes,
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

  it('holds no reviewer name literal', () => {
    const source = readFileSync(join(__dirname, 'handoff.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function composedReturn'));
    for (const reviewer of CODE_REVIEWERS) {
      expect(body).not.toContain(`'${reviewer}'`);
    }
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
