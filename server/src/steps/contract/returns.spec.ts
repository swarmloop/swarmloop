import { STEPS } from '../../contract/steps';
import { assertRoute, JUMPS, RETURNS } from './returns';

const issues = [{ id: 'a-1', source: 'a', title: 't', body: 'b' }];

describe('return and jump tables', () => {
  it('allows each listed return', () => {
    for (const [step, targets] of Object.entries(RETURNS)) {
      for (const target of targets) {
        expect(() => assertRoute(step as never, { to: 'return', step: target, issues })).not.toThrow();
      }
    }
  });

  it('allows each listed jump', () => {
    for (const [step, targets] of Object.entries(JUMPS)) {
      for (const target of targets) {
        expect(() => assertRoute(step as never, { to: 'jump', step: target })).not.toThrow();
      }
    }
  });

  it('rejects a return or jump outside the tables', () => {
    expect(() => assertRoute('plan', { to: 'return', step: 'implement', issues })).toThrow(
      'plan may not return to implement',
    );
    expect(() => assertRoute('code-review', { to: 'return', step: 'plan', issues })).toThrow();
    expect(() => assertRoute('implement', { to: 'jump', step: 'merge-request' })).toThrow();
    expect(() => assertRoute('pipeline', { to: 'jump', step: 'implement' })).toThrow();
  });

  it('ignores the other routes', () => {
    for (const step of STEPS) {
      expect(() => assertRoute(step, { to: 'next' })).not.toThrow();
    }
  });
});
