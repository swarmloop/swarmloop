import { SwarmloopError } from '../../core/swarmloop-error';

export function bulletSection(text: string, name: string): string {
  const block = section(text, name);
  if (block === null) {
    throw new SwarmloopError(`${name} is missing`);
  }
  const lines = items(block).filter((item) => item !== 'none');
  if (lines.length === 0) {
    throw new SwarmloopError(`${name} is empty`);
  }
  return bulletList(lines);
}

export function section(text: string, name: string): string | null {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (isLabelLine(lines[index] ?? '') && heading(lines[index] ?? '') === `${name}:`) {
      start = index;
    }
  }
  if (start < 0) {
    return null;
  }
  const rest: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isSectionLabel(lines[index] ?? '')) {
      break;
    }
    rest.push(lines[index] ?? '');
  }
  return rest.join('\n');
}

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

/** A section ends only at a label of an answer: at column 0, alone on its line, plain or as a heading or bold. */
function isSectionLabel(line: string): boolean {
  const text = heading(line);
  return isLabelLine(line) && text.endsWith(':') && SECTION_LABELS.includes(text.slice(0, -1));
}

function isLabelLine(line: string): boolean {
  return !/^\s/.test(line);
}

/** The last accepted value written on a named section line, including Markdown-wrapped headings. */
export function lastSectionValue(text: string, name: string, values: readonly string[]): string | null {
  let found: string | null = null;
  const prefix = `${name.toLowerCase()}:`;
  for (const line of text.split(/\r?\n/)) {
    const value = heading(line);
    if (!value.startsWith(prefix)) {
      continue;
    }
    const rest = value.slice(prefix.length).trimStart();
    for (const candidate of values) {
      const suffix = rest.slice(candidate.length).replace(/^[`*]+/, '');
      if (rest.startsWith(candidate) && (suffix === '' || /^[\s\-–—:.,;]/.test(suffix))) {
        found = candidate;
      }
    }
  }
  return found;
}

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

export function bulletList(lines: string[]): string {
  if (lines.length === 0) {
    return '';
  }
  return `${lines.map((line) => `- ${line}`).join('\n')}\n`;
}

export function items(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}
