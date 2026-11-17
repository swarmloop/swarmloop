/** Where an agent finds the files of its run. */
const ATTACHMENTS_PATH = '/work/brief/attachments';

/** The prompt with an `Attachments` section that lists each file. A run without files gets its prompt as it is. */
export function withAttachments(prompt: string, names: readonly string[]): string {
  if (names.length === 0) {
    return prompt;
  }
  const list = names.map((name) => `- ${ATTACHMENTS_PATH}/${name}`);
  return [prompt.trimEnd(), '', 'Attachments:', 'Files sent with this run. They are read only.', ...list, ''].join(
    '\n',
  );
}
