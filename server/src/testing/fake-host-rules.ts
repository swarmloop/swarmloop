import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CodeHost, MergeMethod, SelectedHost } from '../integrations/code-host/code-host';
import { git } from './runs.spec-helpers';

export type Answer<M extends keyof CodeHost> = Required<CodeHost>[M] extends (...args: never[]) => infer R ? R : never;

export const FAKE_HOST = 'gitlab.example';
/** The workflow file of this host, which is gitlab. */
export const WORKFLOW_FILE = '.gitlab-ci.yml';

/** What the fake host says it is: gitlab on its fake domain, with a token. */
export function fakeSelected(): SelectedHost {
  return {
    name: 'gitlab',
    baseUrl: `https://${FAKE_HOST}`,
    token: 'token',
    baseKey: 'GITLAB_BASE_URL',
    tokenKey: 'GITLAB_TOKEN',
  };
}

/** What the host's own answer for an account is: its name and no-reply address, either null when the host gives none. */
export interface FakeAuthor {
  name: string | null;
  email: string | null;
}

/** A name the origin or the host accepts only when it matches `pattern` (an extended regular expression). */
export interface FakeNameRule {
  pattern: string;
  /** The host's words in the refusal. */
  message: string;
}

/** What the origin's pre-receive hook refuses: a new branch or a new commit whose name does not match. */
export interface FakeOriginRules {
  branch?: FakeNameRule;
  commit?: FakeNameRule;
}

/** What a spec may set on the fake code host; each part is optional and a default boot sets none. */
export interface FakeHostSettings {
  /** The methods the repository allows, in order. Default: squash, rebase, merge. */
  mergeMethods?: MergeMethod[];
  /** The answer for an account. `'none'` is a host with no no-reply address, so the connection's email is used. Default: the no-reply address. */
  author?: FakeAuthor | 'none';
  /** The host refuses a merge request title that does not match, with the rule's message. */
  title?: FakeNameRule;
  /** The origin refuses a push by its pre-receive hook. */
  origin?: FakeOriginRules;
}

export const DEFAULT_MERGE_METHODS: readonly MergeMethod[] = ['squash', 'rebase', 'merge'];

/** The no-reply address the fake host keeps for an account, as the real hosts do. */
export function noReply(login: string): FakeAuthor {
  return { name: login, email: `1+${login}@users.noreply.${FAKE_HOST}` };
}

function quoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** One check of the hook: the first of `names` that does not match `rule` refuses the push with the rule's message. */
function hookCheck(rule: FakeNameRule, names: string): string {
  const message = quoted(`${rule.message}: `);
  return `bad=$(${names} | grep -Ev -e ${quoted(rule.pattern)} | head -n 1); [ -z "$bad" ] || { printf '%s%s\\n' ${message} "$bad" >&2; exit 1; }`;
}

/**
 * A pre-receive hook on the bare origin. A branch created by a push and every commit a push brings must match the
 * rules. Pushes to `except` (the branch the host merges into) pass, as the host's own merges do.
 */
export function installOriginHook(bare: string, except: string, rules: FakeOriginRules): void {
  const lines = [
    '#!/bin/sh',
    'zero=0000000000000000000000000000000000000000',
    'while read -r old new ref; do',
    '  [ "$new" = "$zero" ] && continue',
    `  [ "$ref" = ${quoted(`refs/heads/${except}`)} ] && continue`,
  ];
  if (rules.branch) {
    lines.push(
      '  if [ "$old" = "$zero" ]; then',
      `    ${hookCheck(rules.branch, 'printf \'%s\\n\' "${ref#refs/heads/}"')}`,
      '  fi',
    );
  }
  if (rules.commit) {
    lines.push(
      '  if [ "$old" = "$zero" ]; then range="$new --not --all"; else range="$old..$new"; fi',
      `  ${hookCheck(rules.commit, 'git log --format=%s $range')}`,
    );
  }
  lines.push('done', 'exit 0', '');
  mkdirSync(join(bare, 'hooks'), { recursive: true });
  const hook = join(bare, 'hooks', 'pre-receive');
  writeFileSync(hook, lines.join('\n'));
  chmodSync(hook, 0o755);
}

/**
 * The commit a merge by `method` adds to `tip` in the repository `clone`: a squash has the merged tree in one commit, a
 * merge has it with `head` as a second parent, and a rebase replays each commit of `head` that `tip` lacks.
 * `title` is the message of a squash or a merge; without one the message names the request.
 */
export function mergeCommit(
  clone: string,
  method: MergeMethod,
  iid: number,
  tip: string,
  head: string | null,
  tree: string,
  title?: string,
): string {
  if (method === 'rebase' && head) {
    return replay(clone, tip, head);
  }
  const parents = method === 'merge' && head ? ['-p', tip, '-p', head] : ['-p', tip];
  return git(clone, [
    'commit-tree',
    tree,
    ...parents,
    '-m',
    title ?? `${method === 'merge' ? 'merge' : 'squash'} !${iid}`,
  ]);
}

function replay(clone: string, tip: string, head: string): string {
  const commits = git(clone, ['rev-list', '--reverse', '--no-merges', `${tip}..${head}`])
    .split('\n')
    .filter(Boolean);
  let top = tip;
  for (const commit of commits) {
    const tree = git(clone, ['merge-tree', '--write-tree', `--merge-base=${commit}^`, top, commit]);
    top = git(clone, ['commit-tree', tree, '-p', top, '-m', git(clone, ['log', '-1', '--format=%B', commit])]);
  }
  return top;
}
