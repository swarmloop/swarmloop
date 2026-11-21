import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SandboxMount } from '../../core/sandbox-mount';
import { SwarmloopError } from '../../core/swarmloop-error';
import { NEAR_TESTS_MARK, NEAR_TESTS_RULE } from './near-tests-rule';
import { alsoReadLine, skillFileReads, STAY_LINE_START } from './outside-reads';
import type { OutsideRead } from './outside-reads';
import { requirementsBrief } from './requirements-brief';

/** The name a prompt gives a mounted repository. */
export function mountLabel(names: string[], mount: SandboxMount, index: number): string {
  return mount.containerPath.startsWith('/work/')
    ? mount.containerPath.slice('/work/'.length)
    : (names[index] ?? names[0] ?? 'work');
}

export function workingDirectoryBlock(names: string[], mounts: SandboxMount[], reads: OutsideRead[] = []): string {
  const labeled = mounts.map((mount, index) => ({
    name: mountLabel(names, mount, index),
    path: mount.containerPath,
    state: sourceState(mount.hostPath),
  }));
  const stay = (where: string): string[] => [
    ...(reads.length > 0 ? [alsoReadLine(reads)] : []),
    `${STAY_LINE_START}${where}. Do not open .git. Do not read the home directory, /opt, /proc, transcripts, or CLI files.`,
  ];
  if (labeled.length === 1) {
    const only = labeled[0];
    return [`The only working directory is ${only.path} (${only.name}). ${only.state}`, ...stay('it')].join('\n');
  }
  const lines = labeled.map((item) => `- ${item.name} at ${item.path}. ${item.state}`);
  return ['Working directories, and nowhere else:', ...lines, ...stay('these paths')].join('\n');
}

export const LOCAL_RUN_RULE =
  'Do not start a service, a database, or the application. Do not run tests on this machine.';

export const PLAN_EXECUTION_RULE = [
  'The execution limits of this planning stage apply only to your current tools and actions.',
  'Do not copy these stage-local limits into the implementation checklist or turn them into project requirements.',
  'Plan the checks the change needs. Implementation uses its own execution environment to decide which commands can run locally.',
  'When revising an existing checklist, remove inherited planning-stage execution limits, but preserve explicit restrictions in the original task or later user instructions.',
].join(' ');

export const AGENT_LANGUAGE_RULE = 'Always write in English, even when the request is in another language.';

export const AGENT_FOREGROUND_RULE =
  'Run every command in the foreground and wait for it. When your answer ends, the process ends.';

function sourceState(hostPath: string): string {
  try {
    const entries = readdirSync(hostPath).filter((name) => name !== '.git');
    return entries.length === 0 ? 'It has no source files.' : 'It has source files.';
  } catch {
    return 'It has no source files.';
  }
}

/** Keeps a `[plan tool] ` line only for a runtime with a plan tool and a `[no plan tool] ` line only for one without. */
export function skillText(raw: string, planTool: boolean): string {
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(PLAN_TOOL_MARK)) {
      if (planTool) {
        kept.push(line.slice(PLAN_TOOL_MARK.length));
      }
    } else if (line.startsWith(NO_PLAN_TOOL_MARK)) {
      if (!planTool) {
        kept.push(line.slice(NO_PLAN_TOOL_MARK.length));
      }
    } else {
      kept.push(line === NEAR_TESTS_MARK ? NEAR_TESTS_RULE : line);
    }
  }
  return kept.join('\n');
}

const PLAN_TOOL_MARK = '[plan tool] ';
const NO_PLAN_TOOL_MARK = '[no plan tool] ';

/** The section of a skill that is for the chat with a person. A first prompt does not carry it. */
const ANSWER_HEADING = '## Answer a person';

/** The text under a `##` heading of a skill, up to the next heading. Empty when the skill has none. */
export function skillSection(skill: string, heading: string): string {
  const file = join(__dirname, '../../../../skills', skill, 'SKILL.md');
  let text: string;
  try {
    text = skillText(readFileSync(file, 'utf8'), true);
  } catch {
    throw new SwarmloopError(`${skill} skill is missing`);
  }
  const start = text.split(new RegExp(`^## ${heading}$`, 'm'))[1];
  return (start?.split(/^## /m)[0] ?? '').trim();
}

export function skillPrompt(
  skill: string,
  requirements: string,
  names: string[],
  sections: { heading: string; body: string }[] = [],
  mounts: SandboxMount[] = [],
  options: {
    deferExecutionRules?: boolean;
    split?: boolean;
    planTool?: boolean;
    rules?: { heading: string; body: string }[];
    reads?: OutsideRead[];
  } = {},
): string {
  const file = join(__dirname, '../../../../skills', skill, 'SKILL.md');
  let text = '';
  try {
    text = skillText(readFileSync(file, 'utf8'), options.planTool ?? true);
  } catch {
    throw new SwarmloopError(`${skill} skill is missing`);
  }
  // The `## Split` section of a skill is for a run that may split. Any other run reads the text before it.
  const first = text.split(new RegExp(`^${ANSWER_HEADING}$`, 'm'))[0] ?? text;
  const body = options.split ? first : (first.split(/^## Split$/m)[0] ?? first);
  const reads = [...(options.reads ?? []), ...skillFileReads(body)];
  const where =
    mounts.length > 0
      ? workingDirectoryBlock(names, mounts, reads)
      : ['Worktrees:', ...names.map((name) => `- ${name}`), ...(reads.length > 0 ? [alsoReadLine(reads)] : [])].join(
          '\n',
        );
  const executionRule = options.deferExecutionRules ? '' : LOCAL_RUN_RULE;
  const parts = [
    where,
    '',
    executionRule,
    '',
    body.trimEnd(),
    '',
    ...(options.rules ?? []).flatMap((rule) => [`${rule.heading}:`, rule.body.trimEnd(), '']),
    'Requirements:',
    requirementsBrief(requirements),
  ];
  for (const section of sections) {
    parts.push('', `${section.heading}:`, section.body.trimEnd());
  }
  return parts.join('\n');
}
