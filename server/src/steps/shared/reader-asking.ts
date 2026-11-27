import { readFileSync } from 'fs';
import { join } from 'path';

/** The skill line that stands for the text of the agents that have a reader. */
export const READING_WITH_A_READER_MARK = '[reading with a reader]';

/** The one copy of how an agent asks its reader, read from `skills/reader/asking.md`. */
export function readingWithAReader(): string {
  return readFileSync(join(__dirname, '../../../../skills', 'reader', 'asking.md'), 'utf8').trimEnd();
}
