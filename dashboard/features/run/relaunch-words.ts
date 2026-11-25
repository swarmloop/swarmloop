import type { RelaunchView } from '@contract/relaunch';
import { phaseLabel } from '../../lib/phase-label';

/** The phases a relaunch runs again in words: `checks and CI`. */
function relaunchPhases(relaunch: RelaunchView): string {
  const words = relaunch.phases.map((phase) => (phase === 'ci' ? 'CI' : phaseLabel(phase)));
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words.join('');
}

/** The relaunch as one sentence: `<reason><separator><phases> run again`. */
export function relaunchLine(relaunch: RelaunchView, separator: string): string {
  return `${relaunch.reason}${separator}${relaunchPhases(relaunch)} run again`;
}
