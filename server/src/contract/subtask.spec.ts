import { parseSubtasks } from './subtask';

describe('parseSubtasks', () => {
  it('parseSubtasks reads depends and status', () => {
    const old = JSON.stringify([{ id: 'a', title: 'A', description: '', files: ['a.ts'], proof: 'p' }]);
    expect(parseSubtasks(old)).toEqual([
      { id: 'a', title: 'A', description: '', files: ['a.ts'], proof: 'p', depends: [], status: 'pending' },
    ]);
    expect(parseSubtasks(JSON.stringify([{ id: 'b', depends: ['a'] }]))[0]?.depends).toEqual(['a']);
    expect(parseSubtasks('not json')).toEqual([]);
  });
});
