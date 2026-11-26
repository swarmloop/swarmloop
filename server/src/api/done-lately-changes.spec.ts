import type { DoneLatelyItem } from '../contract/overview-done';
import { DoneLatelyChanges } from './done-lately-changes';

const item = (key: string) => ({ key, title: key }) as unknown as DoneLatelyItem;

describe('DoneLatelyChanges', () => {
  it('has no baseline until the items are reset, an empty list included', () => {
    const changes = new DoneLatelyChanges();
    expect(changes.hasBaseline()).toBe(false);
    changes.reset([]);
    expect(changes.hasBaseline()).toBe(true);
  });

  it('gives nothing for items equal to the baseline', () => {
    const changes = new DoneLatelyChanges();
    changes.reset([item('a')]);
    expect(changes.since([item('a')])).toBeNull();
  });

  it('gives changed items once and records them as the baseline', () => {
    const changes = new DoneLatelyChanges();
    changes.reset([item('a')]);
    expect(changes.since([item('b'), item('a')])).toEqual([item('b'), item('a')]);
    expect(changes.since([item('b'), item('a')])).toBeNull();
  });
});
