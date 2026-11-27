import type { FlowView } from '@contract/api';
import { phaseLabel } from '../../../lib/phase-label';

type ReturnEdge = FlowView['returns'][number];

const times = (count: number): string => (count === 1 ? 'once' : `${count} times`);

/** One return of the run: `code review → implement · once`, then the return in words when the server gave them. */
export function returnLine(edge: ReturnEdge): string {
  const line = `${phaseLabel(edge.from)} → ${phaseLabel(edge.to)} · ${times(edge.count)}`;
  return edge.words ? `${line} · ${edge.words}` : line;
}

/** Which returns made the visits of a step: `3 visits: code review sent it back once, checks sent it back 2 times`. */
export function visitsLine(step: string, attempts: number, returns: FlowView['returns']): string {
  const causes = returns.filter((edge) => edge.to === step);
  if (attempts <= 1 || causes.length === 0) return '';
  const said = causes.map((edge) => `${phaseLabel(edge.from)} sent it back ${times(edge.count)}`);
  return `${attempts} visits: ${said.join(', ')}`;
}
