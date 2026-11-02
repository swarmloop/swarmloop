export type ShellCommand =
  | { type: 'attach'; key: string | null; vendor: string[] }
  | { type: 'rewind'; key: string | null; to: string | null }
  | { type: 'step'; key: string | null; step: string; prompt: string }
  | { type: 'replay'; key: string | null; prompt: string }
  | { type: 'review'; path: string | null; prompt: string };

const RESERVED = new Set(['rewind', 'step', 'replay', 'review']);

/** A leading run key selects the feature. Anything else that is not reserved goes to the vendor binary. */
export function parseShell(argv: string[], keys: readonly string[]): ShellCommand {
  let key: string | null = null;
  let rest = argv;
  if (rest.length > 0 && keys.includes(rest[0])) {
    key = rest[0];
    rest = rest.slice(1);
  }
  if (rest.length === 0) {
    return { type: 'attach', key, vendor: [] };
  }
  const word = rest[0];
  if (!RESERVED.has(word)) {
    return { type: 'attach', key, vendor: rest };
  }
  if (word === 'rewind') {
    return { type: 'rewind', key, to: flag(rest.slice(1), '--to') };
  }
  if (word === 'step') {
    return { type: 'step', key, step: rest[1] ?? '', prompt: rest.slice(2).join(' ') };
  }
  if (word === 'replay') {
    return { type: 'replay', key, prompt: rest.slice(1).join(' ') };
  }
  const parts = rest.slice(1);
  const first = parts[0] ?? '';
  if (looksLikePath(first)) {
    return { type: 'review', path: first, prompt: parts.slice(1).join(' ') };
  }
  return { type: 'review', path: null, prompt: parts.join(' ') };
}

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

export function pickSnapshot(rows: { id: number }[], answer: string): number | null {
  const id = Number(answer);
  if (!Number.isInteger(id) || !rows.some((row) => row.id === id)) {
    return null;
  }
  return id;
}

function looksLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('.') || value.includes('/') || value.includes('\\');
}
