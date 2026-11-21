import { withOutsideReads } from './outside-reads';
import type { OutsideRead } from './outside-reads';

/** Where an agent finds the files of its run. */
const ATTACHMENTS_PATH = '/work/brief/attachments';

const ATTACHMENTS_READ: OutsideRead = { path: `${ATTACHMENTS_PATH}/`, what: 'the files attached to the task' };

/** The prompt with an `Attachments` section that lists each file. A run without files gets its prompt as it is. */
export function withAttachments(prompt: string, names: readonly string[]): string {
  if (names.length === 0) {
    return prompt;
  }
  const list = names.map((name) => `- ${ATTACHMENTS_PATH}/${name}`);
  const section = [prompt.trimEnd(), '', 'Attachments:', 'Files sent with this run. They are read only.', ...list, ''];
  return withOutsideReads(section.join('\n'), [ATTACHMENTS_READ]);
}
