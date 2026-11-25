import type { Facts } from '../../../history/backlog-writers';

/**
 * The facts of a planner action that only the server reads: the turn's key, and the data a run command is sent again
 * from after a restart. They are never shown to a person.
 */
const RECORD_ONLY_FACTS = [
  'turn',
  'command',
  'index',
  'payload',
  'blockCode',
  'endRun',
  'endStep',
  'endCode',
  'endHeads',
];

/** The facts of a recorded event as a person sees them: plain words, no key of the turn and no stored data. */
export function shownFacts(facts: Facts): Facts {
  return Object.fromEntries(Object.entries(facts).filter(([name]) => !RECORD_ONLY_FACTS.includes(name)));
}
