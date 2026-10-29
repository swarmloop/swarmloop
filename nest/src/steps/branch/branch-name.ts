import cyrillicToTranslit from 'cyrillic-to-translit-js';
import { SwarmloopError } from '../../swarmloop-error';

const KEBAB_LIMIT = 48;
const translit = cyrillicToTranslit({ preset: 'uk' });

export function branchName(key: string, summary: string): string {
  const kebab = translit
    .transform(summary.toLowerCase(), '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, KEBAB_LIMIT)
    .replace(/-+$/g, '');
  if (!kebab) {
    throw new SwarmloopError('branch name is missing');
  }
  return `feature/${key}-${kebab}`;
}

/** GitLab rejects a subject that is only the ticket title. Scope is the Jira key, not the run id. */
export function commitMessage(key: string, summary: string): string {
  const ticket = /^([A-Z][A-Z0-9]*-\d+)/.exec(key)?.[1] ?? key;
  const subject = summary.trim().replace(/\.+$/, '');
  return `feat(${ticket}): ${subject}`;
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
