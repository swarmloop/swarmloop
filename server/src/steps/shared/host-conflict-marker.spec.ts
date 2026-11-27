import { hostConflictMarker, hostConflictOf } from './host-conflict-marker';

describe('host conflict marker', () => {
  it('reads back the text it wrote after the pending line', () => {
    const body = hostConflictMarker('GitHub says it conflicts\nsecond line');
    expect(body.startsWith('pending\n')).toBe(true);
    expect(hostConflictOf(body.slice('pending\n'.length))).toBe('GitHub says it conflicts\nsecond line');
  });

  it('is null for a bare pending, another tag and an empty rest', () => {
    expect(hostConflictOf('')).toBeNull();
    expect(hostConflictOf('parent-own-edits\ntext\n')).toBeNull();
  });
});
