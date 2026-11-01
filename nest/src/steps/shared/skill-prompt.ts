import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { SandboxMount } from '../../sandbox/sandbox-launch';
import { SwarmloopError } from '../../swarmloop-error';
import { bulletSection } from './markdown-section';
import { requirementsBrief } from './requirements-brief';

export function parseSummary(text: string): string {
  return bulletSection(text, 'summary');
}

export function summaryOr(text: string, fallback: string): string {
  try {
    return parseSummary(text);
  } catch (error) {
    if (!(error instanceof SwarmloopError) || (error.message !== 'summary is missing' && error.message !== 'summary is empty')) {
      throw error;
    }
    const body = fallback.trim();
    if (!body) {
      throw new SwarmloopError('summary is missing');
    }
    return body.endsWith('\n') ? body : `${body}\n`;
  }
}

export function plainSummary(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const cleaned = line.replace(/^[`*]+/, '').replace(/[`*]+$/, '').trim();
      if (!cleaned) {
        return false;
      }
      if (/^decision:\s*(ok|return|approve|revise)\s*$/.test(cleaned)) {
        return false;
      }
      if (/^result:\s*(pass|fail)\s*$/.test(cleaned)) {
        return false;
      }
      if (/^(implementation|summary|plan|repos|questions):$/.test(cleaned)) {
        return false;
      }
      return true;
    });
  return lines.map((line) => (line.startsWith('- ') ? line : `- ${line}`)).join('\n');
}

export function workingDirectoryBlock(names: string[], mounts: SandboxMount[]): string {
  const labeled = mounts.map((mount, index) => ({
    name: mount.containerPath.startsWith('/work/') ? mount.containerPath.slice('/work/'.length) : (names[index] ?? names[0] ?? 'work'),
    path: mount.containerPath,
    state: sourceState(mount.hostPath),
  }));
  const stay = (where: string): string =>
    `Do not look outside ${where}. Do not open .git. Do not read the home directory, /opt, /proc, transcripts, or CLI files.`;
  if (labeled.length === 1) {
    const only = labeled[0];
    return [`The only working directory is ${only.path} (${only.name}). ${only.state}`, stay('it')].join('\n');
  }
  const lines = labeled.map((item) => `- ${item.name} at ${item.path}. ${item.state}`);
  return ['Working directories, and nowhere else:', ...lines, stay('these paths')].join('\n');
}

export const LOCAL_RUN_RULE = 'Do not start a service, a database, or the application. Do not run tests on this machine.';

export const AGENT_LANGUAGE_RULE = 'Always write in English, even when the request is in another language.';

function sourceState(hostPath: string): string {
  try {
    const entries = readdirSync(hostPath).filter((name) => name !== '.git');
    return entries.length === 0 ? 'It has no source files.' : 'It has source files.';
  } catch {
    return 'It has no source files.';
  }
}

export function skillPrompt(
  skill: string,
  requirements: string,
  names: string[],
  sections: { heading: string; body: string }[] = [],
  mounts: SandboxMount[] = [],
): string {
  const file = join(__dirname, '../../../../skills', skill, 'SKILL.md');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new SwarmloopError(`${skill} skill is missing`);
  }
  const where = mounts.length > 0 ? workingDirectoryBlock(names, mounts) : ['Worktrees:', ...names.map((name) => `- ${name}`)].join('\n');
  const parts = [where, '', LOCAL_RUN_RULE, '', text.trimEnd(), '', 'Requirements:', requirementsBrief(requirements)];
  for (const section of sections) {
    parts.push('', `${section.heading}:`, section.body.trimEnd());
  }
  return parts.join('\n');
}
