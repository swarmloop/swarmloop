import type { GitChange, GitRules } from '../../agent-result/definitions/git-change';

/** What the implement agent answered to a host's refusal of a name. */
export interface RefusalAnswer {
  change: GitChange;
  gitRules?: GitRules;
}

export type RefusedKind = 'branch' | 'commit' | 'title';

/** The event an answer is for: the first refusal of a kind in a repository. */
export function refusalKey(repo: string, kind: RefusedKind): string {
  return `git-refusal:${repo}:${kind}`;
}

/** A `git_refusal` document: the key on its first line, the answer as JSON after it. */
export function formatRefusal(key: string, answer: RefusalAnswer): string {
  return `${key}\n${JSON.stringify(answer)}\n`;
}

/** The key and the answer of a stored document, or null when it does not read. */
export function parseRefusal(body: string): { key: string; answer: RefusalAnswer } | null {
  const at = body.indexOf('\n');
  try {
    const answer = JSON.parse(body.slice(at + 1)) as RefusalAnswer;
    return at > 0 && answer.change ? { key: body.slice(0, at), answer } : null;
  } catch {
    return null;
  }
}
