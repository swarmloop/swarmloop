import { checkRun, type CheckEntry } from './environment-config';

const MAX_NAME = 24;
const MAX_WORDS = 3;
const PLAIN_WORD = /^[A-Za-z0-9][\w@./:-]*$/;

/** The leading plain words of a command: a flag or a symbol ends the label. */
function labelOf(command: string): string {
  const words: string[] = [];
  for (const token of command.trim().split(/\s+/)) {
    if (words.length === MAX_WORDS || !PLAIN_WORD.test(token)) {
      break;
    }
    words.push(token);
  }
  return (words.length > 0 ? words.join(' ') : command.trim()).slice(0, MAX_NAME).trimEnd();
}

/** The shown name of each check of one repository, in order: the given name, else a short label, unique in the list. */
export function checkNames(entries: CheckEntry[]): string[] {
  const used = new Set<string>();
  return entries.map((entry) => {
    const base = (typeof entry === 'string' ? undefined : entry.name) ?? labelOf(checkRun(entry));
    let name = base;
    for (let n = 2; used.has(name); n++) {
      const suffix = ` ${n}`;
      name = `${base.slice(0, MAX_NAME - suffix.length).trimEnd()}${suffix}`;
    }
    used.add(name);
    return name;
  });
}
