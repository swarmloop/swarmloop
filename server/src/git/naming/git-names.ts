import cyrillicToTranslit from 'cyrillic-to-translit-js';
import type { GitChange } from '../../agent-result/definitions/git-change';
import { SwarmloopError } from '../../core/swarmloop-error';
import { renderTemplate, type NameValues } from './name-template';

const KEBAB_LIMIT = 48;
const BRANCH_LIMIT = 99;
const translit = cyrillicToTranslit({ preset: 'uk' });

/** The built-in formats: today's names. A repository with no format of its own gets these. */
const BRANCH_DEFAULT = 'feature/{key}-{slug}';
const COMMIT_DEFAULT = 'feat({ticket}): {summary}';
const TITLE_DEFAULT = '{summary}';

/** What a name is rendered from, besides the run: the repository's template (null for the built-in one) and the meaning. */
interface Rendering {
  template?: string | null;
  change?: GitChange;
  /** The title of a split task, for `{task}`. */
  task?: string;
}

function kebab(summary: string): string {
  return translit
    .transform(summary.toLowerCase(), '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, KEBAB_LIMIT)
    .replace(/-+$/g, '');
}

/** The ticket key a run key starts with: a Jira key, with no suffix of a subtask. */
function ticketOf(key: string): string {
  return /^([A-Z][A-Z0-9]*-\d+)/.exec(key)?.[1] ?? '';
}

function valuesOf(key: string, summary: string, rendering: Rendering): NameValues {
  const { change } = rendering;
  const ticket = ticketOf(key);
  // A template of the repository sees the ticket or nothing; only the built-in one stands in the key.
  return {
    type: change?.type ?? 'feat',
    scope: change?.scope ?? '',
    subject: (change?.subject ?? summary).trim(),
    summary,
    ticket: typeof rendering.template === 'string' ? ticket : ticket || key,
    slug: kebab(summary),
    key,
    task: rendering.task ?? '',
  };
}

/** What a branch name may carry of a value: the key and the ticket as they are, every other value in the slug's rule. */
function branchValues(values: NameValues): NameValues {
  const safe: NameValues = { ...values };
  for (const name of ['type', 'scope', 'subject', 'summary', 'task'] as const) {
    safe[name] = kebab(values[name] ?? '');
  }
  return safe;
}

/** The built-in name is today's, whatever its length; a template of the repository is cut under 100 characters. */
export function branchName(key: string, summary: string, rendering: Rendering = {}): string {
  const values = valuesOf(key, summary, rendering);
  if (!values.slug) {
    throw new SwarmloopError('branch name is missing');
  }
  const name = renderTemplate(rendering.template ?? BRANCH_DEFAULT, branchValues(values)).replace(/\s+/g, '-');
  return typeof rendering.template === 'string' ? name.slice(0, BRANCH_LIMIT).replace(/[-/]+$/g, '') : name;
}

/** A code host rejects a subject that is only the ticket title. Scope is the Jira key, not the run id. */
export function commitMessage(key: string, summary: string, rendering: Rendering = {}): string {
  const values = valuesOf(key, summary.trim().replace(/\.+$/, ''), rendering);
  const subject = values.subject?.replace(/\.+$/, '');
  return renderTemplate(rendering.template ?? COMMIT_DEFAULT, { ...values, subject }).replace(/\.+$/, '');
}

export function mergeRequestTitle(key: string, summary: string, rendering: Rendering = {}): string {
  return renderTemplate(rendering.template ?? TITLE_DEFAULT, valuesOf(key, summary, rendering));
}

export function summaryForBranch(body: string, key: string): string {
  let record: { prompt?: string | null; tickets?: { key?: string; summary?: string }[] };
  try {
    record = JSON.parse(body) as typeof record;
  } catch {
    throw new SwarmloopError('requirements is not readable');
  }
  const ticket = record.tickets?.find((item) => item.key === key) ?? record.tickets?.[0];
  return ticket?.summary?.trim() || record.prompt?.trim().split('\n')[0]?.trim() || '';
}
