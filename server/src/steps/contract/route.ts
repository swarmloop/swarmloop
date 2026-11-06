import type { StepName } from '../../contract/steps';
import type { Route } from './step-contract';

interface RouteEnd {
  outcome: 'ok' | 'failed' | 'blocked' | 'waiting';
  exitCode: number;
  moveTo?: StepName;
}

/** The end a route stands for. Block and fail exit 1, every other route exits 0, unless `exitCode` says otherwise. */
export function routeToEnd(route: Route, exitCode?: number): RouteEnd {
  switch (route.to) {
    case 'next':
      return end('ok', exitCode ?? 0);
    case 'jump':
      return end('ok', exitCode ?? 0, route.step);
    case 'return':
      return end('waiting', exitCode ?? 0, route.step);
    case 'wait':
      return end('waiting', exitCode ?? 0);
    case 'block':
      return end('blocked', exitCode ?? 1);
    case 'fail':
      return end('failed', exitCode ?? 1);
  }
}

function end(outcome: RouteEnd['outcome'], exitCode: number, moveTo?: StepName): RouteEnd {
  return { outcome, exitCode, moveTo };
}
