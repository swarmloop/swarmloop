import { legacyPlanItems, legacyPlanObjectItems } from './plan';

describe('legacyPlanItems', () => {
  it('reads the bullets of the plan section and stops at the next label', () => {
    expect(legacyPlanItems('plan:\n- add the field\n- cover the empty case\n\nsummary:\n- why\n')).toEqual([
      'add the field',
      'cover the empty case',
    ]);
  });

  it('reads the last plan section when an answer holds two', () => {
    expect(legacyPlanItems('plan:\n- old item\n\nplan:\n- new item\n')).toEqual(['new item']);
  });

  it('keeps a colon in an item', () => {
    const item = 'add X - files: a.ts - proof: a.spec.ts';
    expect(legacyPlanItems(`plan:\n- ${item}\n- old item\n`)).toEqual([item, 'old item']);
  });

  it('gives nothing for a missing section or none', () => {
    expect(legacyPlanItems('no section')).toEqual([]);
    expect(legacyPlanItems('plan:\n- none\n')).toEqual([]);
  });
});

describe('legacyPlanObjectItems', () => {
  it('reads the items of a plan object inside the section', () => {
    const plan = { name: 'n', overview: 'o', items: ['a', 'none', 'b'] };
    expect(legacyPlanObjectItems(`plan:\n${JSON.stringify(plan, null, 2)}\n`)).toEqual(['a', 'b']);
  });

  it('gives null without a section, without an object and for an object that is not a plan', () => {
    expect(legacyPlanObjectItems('summary:\n- x\n')).toBeNull();
    expect(legacyPlanObjectItems('plan:\ntext only\n')).toBeNull();
    expect(legacyPlanObjectItems('plan:\n{"items":["a"]}\n')).toBeNull();
    expect(legacyPlanObjectItems('plan:\n{not json}\n')).toBeNull();
  });
});
