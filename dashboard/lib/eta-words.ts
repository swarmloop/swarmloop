import type { RunEta } from '@contract/eta';
import { etaWords } from '@contract/eta';
import { localTime } from './format';

/** The words of an estimate counted down to `now`, so a surface that ticks `now` needs no new request. */
export function etaText(eta: RunEta, now: number): { text: string; tip: string } {
  if (eta.doneAt === null) {
    return etaWords(eta, localTime);
  }
  return etaWords({ leftMs: Math.max(0, Date.parse(eta.doneAt) - now), doneAt: eta.doneAt }, localTime);
}
