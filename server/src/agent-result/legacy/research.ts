// remove after runs started before f52 are gone
import { legacyItems } from './prose-lines';

/** The open questions of a stored `questions` document. `none` is no question. */
export function legacyQuestions(body: string): string[] {
  return legacyItems(body).filter((item) => item !== 'none');
}
