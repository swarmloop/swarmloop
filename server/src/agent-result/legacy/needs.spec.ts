import { parseNeeds } from './needs';

describe('parseNeeds', () => {
  it('reads one need per line and drops a malformed line', () => {
    const text = [
      'summary:',
      '- chose x',
      '',
      'needs:',
      '- http-retry: the retry policy',
      '- no colon here',
      '- `reasons-core`: codes',
    ].join('\n');

    expect(parseNeeds(text)).toEqual([
      { id: 'http-retry', what: 'the retry policy' },
      { id: 'reasons-core', what: 'codes' },
    ]);
  });

  it('gives none when the section is absent or says none', () => {
    expect(parseNeeds('summary:\n- done')).toEqual([]);
    expect(parseNeeds('needs:\n- none')).toEqual([]);
  });
});
