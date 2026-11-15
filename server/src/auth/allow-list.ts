import { SwarmloopError } from '../core/swarmloop-error';
import { codeHostAdapters } from '../integrations/code-host/code-host-adapters';
import type { ProviderName } from '../integrations/code-host/login-provider';

type Kind = 'user' | 'group';
interface Entry {
  provider: ProviderName;
  kind: Kind;
  name: string;
}

/** Built when called: the config schema imports this file before the adapters can load. */
function prefixes(): { table: Record<string, Pick<Entry, 'provider' | 'kind'>>; shapes: string[] } {
  const table: Record<string, Pick<Entry, 'provider' | 'kind'>> = {};
  const shapes: string[] = [];
  for (const { name, allowPrefixes } of codeHostAdapters()) {
    table[allowPrefixes.user] = { provider: name, kind: 'user' };
    table[allowPrefixes.group] = { provider: name, kind: 'group' };
    shapes.push(
      `${allowPrefixes.user}<user>`,
      `${allowPrefixes.group}<${allowPrefixes.group.slice(name.length + 1, -1)}>`,
    );
  }
  return { table, shapes };
}

/** The entry shapes as a sentence list: `a, b or c`. */
function shapesText(shapes: string[]): string {
  return `${shapes.slice(0, -1).join(', ')} or ${shapes[shapes.length - 1]}`;
}

/** The entries of `SWARMLOOP_ALLOW`, comma-separated. A bad entry is an error naming it. */
export function parseAllow(raw: string): Entry[] {
  const { table, shapes } = prefixes();
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => {
      const prefix = Object.keys(table).find((candidate) => item.toLowerCase().startsWith(candidate));
      const name = prefix ? item.slice(prefix.length).trim().toLowerCase() : '';
      if (!prefix || name === '') {
        throw new SwarmloopError(`SWARMLOOP_ALLOW entry "${item}" is not ${shapesText(shapes)}`);
      }
      return { ...table[prefix], name };
    });
}

interface Login {
  provider: ProviderName;
  user: string;
  groups: string[];
}

type Verdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Who may log in. An empty list lets in whoever `push` says can push to a repository this server works on, or whom `first` says is the first person on the
 * server's own machine; without
 * `push` it lets in only the owner of the configured token of that provider, which `owner` looks up (null when no
 * token is configured).
 */
export async function decide(
  entries: Entry[],
  login: Login,
  owner: () => Promise<string | null>,
  push?: () => Promise<boolean>,
  first?: () => Promise<boolean>,
): Promise<Verdict> {
  const user = login.user.toLowerCase();
  if (entries.length === 0 && push) {
    if ((await push()) || (first && (await first()))) {
      return { allowed: true };
    }
    return { allowed: false, reason: "can't push to any repository this server works on" };
  }
  if (entries.length === 0) {
    const tokenOwner = await owner();
    if (tokenOwner === null) {
      return { allowed: false, reason: `SWARMLOOP_ALLOW is empty and no ${login.provider} token is configured` };
    }
    return tokenOwner.toLowerCase() === user
      ? { allowed: true }
      : { allowed: false, reason: `only the owner of the configured ${login.provider} token may log in` };
  }
  const groups = login.groups.map((group) => group.toLowerCase());
  const listed = entries.some(
    (entry) =>
      entry.provider === login.provider && (entry.kind === 'user' ? entry.name === user : groups.includes(entry.name)),
  );
  return listed ? { allowed: true } : { allowed: false, reason: 'not listed in SWARMLOOP_ALLOW' };
}
