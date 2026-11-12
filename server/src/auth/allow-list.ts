import { SwarmloopError } from '../core/swarmloop-error';
import type { ProviderName } from './oauth-provider';

type Kind = 'user' | 'group';
interface Entry {
  provider: ProviderName;
  kind: Kind;
  name: string;
}

const PREFIXES: Record<string, Pick<Entry, 'provider' | 'kind'>> = {
  'github:': { provider: 'github', kind: 'user' },
  'github-org:': { provider: 'github', kind: 'group' },
  'gitlab:': { provider: 'gitlab', kind: 'user' },
  'gitlab-group:': { provider: 'gitlab', kind: 'group' },
};

/** The entries of `SWARMLOOP_ALLOW`, comma-separated. A bad entry is an error naming it. */
export function parseAllow(raw: string): Entry[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => {
      const prefix = Object.keys(PREFIXES).find((candidate) => item.toLowerCase().startsWith(candidate));
      const name = prefix ? item.slice(prefix.length).trim().toLowerCase() : '';
      if (!prefix || name === '') {
        throw new SwarmloopError(
          `SWARMLOOP_ALLOW entry "${item}" is not github:<user>, github-org:<org>, gitlab:<user> or gitlab-group:<group>`,
        );
      }
      return { ...PREFIXES[prefix], name };
    });
}

interface Login {
  provider: ProviderName;
  user: string;
  groups: string[];
}

type Verdict = { allowed: true } | { allowed: false; reason: string; message?: string };

/**
 * Who may log in. An empty list lets in whoever `push` says can push to a repository this server works on; without
 * `push` it lets in only the owner of the configured token of that provider, which `owner` looks up (null when no
 * token is configured).
 */
export async function decide(
  entries: Entry[],
  login: Login,
  owner: () => Promise<string | null>,
  push?: () => Promise<boolean>,
): Promise<Verdict> {
  const user = login.user.toLowerCase();
  if (entries.length === 0 && push) {
    if (await push()) {
      return { allowed: true };
    }
    const reason = "can't push to any repository this server works on";
    return { allowed: false, reason, message: `${login.provider}:${login.user} ${reason}` };
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
