import type { Route } from './step-contract';
import { routeToEnd } from './route';

const issues = [{ id: '1', source: 'review', title: 'fix it', body: 'details' }];

const CASES: [string, Route, { outcome: string; moveTo?: string; exitCode: number }][] = [
  ['next', { to: 'next' }, { outcome: 'ok', exitCode: 0 }],
  ['jump', { to: 'jump', step: 'commit' }, { outcome: 'ok', moveTo: 'commit', exitCode: 0 }],
  ['return', { to: 'return', step: 'implement', issues }, { outcome: 'waiting', moveTo: 'implement', exitCode: 0 }],
  ['wait', { to: 'wait', reason: 'questions' }, { outcome: 'waiting', exitCode: 0 }],
  ['block', { to: 'block', reason: 'does not fit' }, { outcome: 'blocked', exitCode: 1 }],
  ['fail', { to: 'fail', error: { code: 'x', message: 'boom' } }, { outcome: 'failed', exitCode: 1 }],
];

describe('routeToEnd', () => {
  it.each(CASES)('maps %s to its outcome, move and default exit code', (_name, route, expected) => {
    expect(routeToEnd(route)).toEqual({ moveTo: undefined, ...expected });
  });

  it.each(CASES)('keeps an explicit exit code on %s', (_name, route, expected) => {
    expect(routeToEnd(route, 7)).toEqual({ moveTo: undefined, ...expected, exitCode: 7 });
  });
});
