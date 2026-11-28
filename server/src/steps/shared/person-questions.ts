import { answeredBefore, type AnsweredQuestion, type StoredQuestion } from './question-parts';

/** What a run already holds for the person: the open question lines, their stored parts and the answers given before. */
export interface PersonHeld {
  lines: string[];
  parts: StoredQuestion[];
  answered: AnsweredQuestion[];
}

/** An answer the person gave before, or the open lines and parts once the question is among them. */
export type PersonAsk =
  { kind: 'answered'; answer: string } | { kind: 'asked'; lines: string[]; parts: StoredQuestion[] };

/**
 * The one writer of a question for a person. A question that its asker and decision text were answered before gives
 * that answer and adds nothing. Any other is added once to the open lines, and the parts are those of the open lines
 * plus the ask.
 */
export function askPerson(held: PersonHeld, ask: StoredQuestion): PersonAsk {
  const answer = answeredBefore(held.answered, ask.parts.asker ?? '', ask.parts.decide);
  if (answer !== null) return { kind: 'answered', answer };
  const open = held.parts.filter((item) => held.lines.includes(item.question) && item.question !== ask.question);
  return {
    kind: 'asked',
    lines: held.lines.includes(ask.question) ? held.lines : [...held.lines, ask.question],
    parts: [...open, ask],
  };
}
