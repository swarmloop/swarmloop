// remove after runs started before f52 are gone
const SECTION_LABELS = [
  'contract',
  'keep',
  'tasks',
  'plan',
  'questions',
  'summary',
  'impact',
  'implementation',
  'cause',
  'files',
  'proof',
  'needs',
];

function heading(line: string): string {
  let text = line.trim().replace(/^#{1,6}\s+/, '');
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text
      .trim()
      .replace(/^[`*]+/, '')
      .replace(/[`*]+$/, '')
      .trim();
  }
  return text.toLowerCase();
}

function isLabel(line: string, name?: string): boolean {
  const text = heading(line);
  return (
    !/^\s/.test(line) && text.endsWith(':') && (name ? text === `${name}:` : SECTION_LABELS.includes(text.slice(0, -1)))
  );
}

/** The lines under the last label of a name, up to the next label. Null when there is none. */
export function legacySection(text: string, name: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.map((line) => isLabel(line, name)).lastIndexOf(true);
  if (start < 0) {
    return null;
  }
  const rest: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (isLabel(line)) {
      break;
    }
    rest.push(line);
  }
  return rest.join('\n');
}

/** The `- ` lines of a block, trimmed. */
export function legacyItems(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}
