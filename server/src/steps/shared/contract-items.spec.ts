import { readContract } from './contract-items';
import { withDecision } from './handoff';

describe('readContract', () => {
  it('reads items with their id, owner and text, and the decisions under the heading', () => {
    const contract = [
      '- api (owner core): withHostRetries in http.ts\n  keeps its line breaks',
      '- format (owner docs): ISO times',
      '',
      'decisions:',
      '- git-retry depends on http-retry: both change http.ts',
      '- subtask core: the name stays',
      '- subtask docs at 2026-11-19T10:00:00.000Z: use UTC\n  everywhere',
    ].join('\n');
    expect(readContract(contract)).toEqual({
      items: [
        { id: 'api', owner: 'core', text: 'withHostRetries in http.ts\nkeeps its line breaks' },
        { id: 'format', owner: 'docs', text: 'ISO times' },
      ],
      decisions: [
        { task: '', at: null, text: 'git-retry depends on http-retry: both change http.ts' },
        { task: 'core', at: null, text: 'the name stays' },
        { task: 'docs', at: '2026-11-19T10:00:00.000Z', text: 'use UTC\neverywhere' },
      ],
    });
  });

  it('reads an old text contract as items with no id and no owner, and decisions with no time', () => {
    const contract = '- the column is called `split`\n- a second rule\n\ndecisions:\n- subtask a: store UTC';
    expect(readContract(contract)).toEqual({
      items: [
        { id: '', owner: '', text: 'the column is called `split`' },
        { id: '', owner: '', text: 'a second rule' },
      ],
      decisions: [{ task: 'a', at: null, text: 'store UTC' }],
    });
  });

  it('reads a contract with no decisions heading, and an empty one', () => {
    expect(readContract('- one rule').decisions).toEqual([]);
    expect(readContract('')).toEqual({ items: [], decisions: [] });
  });

  it('reads back what withDecision writes, with and without a time', () => {
    const withTime = withDecision('- x (owner a): y', 'b', 'first\nsecond', '2026-11-19T10:00:00.000Z');
    const both = withDecision(withTime, 'c', 'later');
    expect(readContract(both).decisions).toEqual([
      { task: 'b', at: '2026-11-19T10:00:00.000Z', text: 'first\nsecond' },
      { task: 'c', at: null, text: 'later' },
    ]);
  });
});
