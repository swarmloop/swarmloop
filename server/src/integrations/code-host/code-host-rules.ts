import { codeHostAdapters } from './code-host-adapters';

const HOST_RULES = codeHostAdapters().map((adapter) => adapter.rules);

/** The earliest line that any host explains a refused push with. */
export function pushRejectionOfAnyHost(lines: string[]): string | undefined {
  const index = Math.min(
    ...HOST_RULES.map((rules) => {
      const line = rules.pushRejection(lines);
      return line === undefined ? Infinity : lines.indexOf(line);
    }),
  );
  return lines[index];
}

/** The display name of a host, or null for a name no host has. */
export function codeHostLabel(name: string): string | null {
  return HOST_RULES.find((rules) => rules.name === name)?.label ?? null;
}
