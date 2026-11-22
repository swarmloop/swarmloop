import { recordedAfter, sinceRecorded } from './since-recorded';

describe('sinceRecorded', () => {
  it('charges a fresh chat in full', () => {
    expect(sinceRecorded(1.25, 0)).toBe(1.25);
  });

  it('subtracts the chat total already recorded when the total covers the whole chat', () => {
    expect(sinceRecorded(4, 3)).toBe(1);
    expect(sinceRecorded(3, 3)).toBe(0);
  });

  it('keeps a smaller number as this visit alone', () => {
    expect(sinceRecorded(1, 3)).toBe(1);
  });
});

describe('recordedAfter', () => {
  it('moves the recorded total to a session total, or adds a visit that is its own', () => {
    expect(recordedAfter(4, 3)).toBe(4);
    expect(recordedAfter(1, 3)).toBe(4);
  });
});
