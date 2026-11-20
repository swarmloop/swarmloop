import { branchName } from './git-names';

/** The `branch_names` document: one `<repo> <branch>` line per repository. */
export function parseBranchNames(body: string | null): Map<string, string> {
  const lines = new Map<string, string>();
  for (const line of (body ?? '').split('\n')) {
    const at = line.indexOf(' ');
    if (at > 0 && at < line.length - 1) {
      lines.set(line.slice(0, at), line.slice(at + 1).trim());
    }
  }
  return lines;
}

export function formatBranchNames(lines: Map<string, string>): string {
  return [...lines].map(([repo, branch]) => `${repo} ${branch}\n`).join('');
}

/**
 * The stored branch of a repository, or the name this run would have had before names were stored. A run of one
 * branch for every repository (a split run) is asked with no repository, and answers with its first line.
 */
export function storedBranch(body: string | null, repo: string | null, key: string, summary: string): string {
  const lines = parseBranchNames(body);
  return (repo === null ? [...lines.values()][0] : lines.get(repo)) ?? branchName(key, summary);
}
