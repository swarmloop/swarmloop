import { withAdditions } from './requirement-additions';

describe('withAdditions', () => {
  it('adds each text under the next R id and keeps the list as it was', () => {
    const list = [
      { id: 'R1', text: 'one' },
      { id: 'R2', text: 'two' },
    ];
    expect(withAdditions(list, ['three', ' four '])).toEqual([
      ...list,
      { id: 'R3', text: 'three' },
      { id: 'R4', text: 'four' },
    ]);
  });

  it('uses the T series when the list holds a task requirement', () => {
    expect(withAdditions([{ id: 'T1', text: 'one' }], ['two'])).toEqual([
      { id: 'T1', text: 'one' },
      { id: 'T2', text: 'two' },
    ]);
  });

  it('leaves the list as it was for no texts or blank ones', () => {
    const list = [{ id: 'R1', text: 'one' }];
    expect(withAdditions(list, [])).toEqual(list);
    expect(withAdditions(list, ['  ', ''])).toEqual(list);
  });

  it('starts at R1 on an empty list', () => {
    expect(withAdditions([], ['first'])).toEqual([{ id: 'R1', text: 'first' }]);
  });
});
