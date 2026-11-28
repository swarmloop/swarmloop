import { paysPastLimit } from './paid-use';

describe('paysPastLimit', () => {
  it('is off for a runtime that reads paid use when nothing is stored', () => {
    expect(paysPastLimit(true, undefined)).toBe(false);
  });

  it('is off for a runtime that reads paid use when the person stored false', () => {
    expect(paysPastLimit(true, false)).toBe(false);
  });

  it('is on for a runtime that reads paid use when the person stored true', () => {
    expect(paysPastLimit(true, true)).toBe(true);
  });

  it('is on for a runtime that cannot read paid use, whatever is stored', () => {
    expect(paysPastLimit(false, undefined)).toBe(true);
    expect(paysPastLimit(false, false)).toBe(true);
  });
});
