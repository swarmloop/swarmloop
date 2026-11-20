import { requirementsCheck } from './requirements-check';

const LIST = [
  { id: 'R1', text: 'Parse the field' },
  { id: 'R2', text: 'Keep the segment' },
];

const mark = (id: string, status: 'met' | 'partial' | 'missing' = 'met') => ({ id, status, note: `note ${id}` });
const answer = (ids: string[], decision: 'ok' | 'return' = 'ok') => ({
  decision,
  review: '',
  summary: [],
  requirements: ids.map((id) => mark(id)),
});

describe('requirementsCheck', () => {
  it('asks for one entry for each requirement and for each contract item of a split parent', () => {
    const check = requirementsCheck(LIST, ['c1', 'c2']);

    expect(check(answer(['R1', 'R2', 'c1', 'c2']))).toEqual([]);
    expect(check(answer(['R1', 'R2', 'c1']))).toEqual([
      'c2 has no entry in requirements: give one entry for each id of the contract items',
    ]);
  });

  it('refuses an id that is neither a requirement nor a contract item', () => {
    expect(requirementsCheck(LIST, ['c1'])(answer(['R1', 'R2', 'c1', 'x9']))).toEqual([
      'x9 is not an id of the Requirements list or of the contract items',
    ]);
  });

  it("keeps today's messages when there are no contract items", () => {
    const check = requirementsCheck(LIST);

    expect(check(answer(['R1']))).toEqual([
      'R2 has no entry in requirements: give one entry for each id of the Requirements list',
    ]);
    expect(check(answer(['R1', 'R2', 'c1']))).toEqual(['c1 is not an id of the Requirements list']);
  });

  it('returns a contract item that is partial like a requirement', () => {
    const value = { ...answer(['R1', 'R2']), requirements: [mark('R1'), mark('R2'), mark('c1', 'partial')] };

    expect(requirementsCheck(LIST, ['c1'])(value)).toEqual([
      'decision is ok but c1 is not met: any partial or missing requirement is a return',
    ]);
  });
});
