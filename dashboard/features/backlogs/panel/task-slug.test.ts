import { describe, expect, it } from 'vitest';
import { taskSlug } from './task-slug';

describe('taskSlug', () => {
  it('uses lowercase letters, digits and dashes only', () => {
    expect(taskSlug('  Pay by Card, v2!  ', [])).toBe('pay-by-card-v2');
  });

  it('falls back to task when nothing is left', () => {
    expect(taskSlug('???', [])).toBe('task');
    expect(taskSlug('', [])).toBe('task');
  });

  it('adds a number until the id is not among the existing ones', () => {
    expect(taskSlug('Pay', ['pay', 'pay-2'])).toBe('pay-3');
  });
});
