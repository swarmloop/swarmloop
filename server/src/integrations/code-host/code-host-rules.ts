import type { CodeHostRules } from './host-rules';
import { githubRules } from './github/github-rules';
import { gitlabRules } from './gitlab/gitlab-rules';

const HOST_RULES: readonly CodeHostRules[] = [githubRules, gitlabRules];

export function ciFilesOfAnyHost(): string[] {
  return HOST_RULES.flatMap((rules) => rules.ciFiles);
}

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
