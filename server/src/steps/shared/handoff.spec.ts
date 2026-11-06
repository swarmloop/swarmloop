import { readFileSync } from 'fs';
import { join } from 'path';
import { CODE_REVIEWERS } from '../../contract/steps';
import { composedReturn, issueOf, returnNotes } from './handoff';

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
