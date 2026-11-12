import type { EnvironmentRecord } from './environment-types';
import { checkRun } from './environment-config';

export function environmentNote(record: EnvironmentRecord, step?: string): string {
  const { config } = record;
  const extra = config.network === 'setup' ? [] : (config.hosts?.agent ?? []);
  const improving = step === 'implement-improve';
  const lines = [
    `# Project environment`,
    'These are the execution capabilities of the current implementation stage, including resumed sessions.',
    'Planning and read-only review restrictions apply only to those earlier stages. A sandbox test ban copied from those stages into a checklist does not restrict this project environment.',
    'Preserve explicit restrictions from the original task and later user instructions. If they conflict with required checks, explain the conflict rather than silently overriding them.',
    `This container runs in ${record.image ?? config.image ?? 'the project image'} from ${config.source} of ${record.repo}, with the project's own toolchain.`,
    config.network === 'setup'
      ? 'You may run any command in the working directory: build, lint, type check, and tests. The dependencies were installed by the setup; package registries are not reachable, so you cannot add or update a dependency. When the task needs a new one, say so in the summary. There is no Docker, no database or other service, and no other network.'
      : `You may run any command in the working directory: build, lint, type check, tests, and the package manager. Package registries are reachable${extra.length > 0 ? `, and so are these hosts: ${extra.join(', ')}` : ''}, so you can add or update a dependency; the lockfile it writes is committed with your work. There is no Docker, no database or other service, and no other network.`,
  ];
  if (config.checks.length > 0) {
    lines.push(
      improving
        ? 'The implement agent already ran the full checks in its session. When this pass changes no file, do not run them again. When it changes files, run the narrowest command that covers the change, because the server runs the full checks after this answer, before code review. These are the checks:'
        : 'Run these checks when a coherent piece of work is done and always before your final summary. When one fails, fix the cause and run it again. Do not run them after every small edit.',
      ...config.checks.map((check) => `- \`${checkRun(check)}\``),
    );
  } else {
    lines.push(
      'The repository names no checks. Find its test, lint and type check commands in the README, the package scripts or the CI config, and run those before your final summary.',
    );
  }
  lines.push(
    'While you work, run the narrowest command that covers your change, such as one test file, and keep the output short: read the failures, not the whole log. Run the full checks once at the end.',
    'After a pipeline return, run the failing command here first, fix it, and run it again before you finish.',
  );
  if (config.setup && config.network !== 'setup') {
    lines.push(`If a dependency or a generated file is missing, run the setup again: \`${config.setup}\`.`);
  }
  lines.push(
    'CI configuration may be changed when required by the task. Describe changes to workflow triggers, permissions, secret access, and runners in the summary.',
  );
  const setup = record.setup;
  if (setup && setup.exitCode !== 0) {
    lines.push(
      config.network === 'setup'
        ? `The setup \`${setup.command}\` failed with exit ${setup.exitCode}. Fix the cause when it is in the repository, and say in the summary what could not be installed. Its last lines:`
        : `The setup \`${setup.command}\` failed with exit ${setup.exitCode}. Fix the cause when it is in the repository, or install what is missing yourself. Its last lines:`,
      '```',
      setup.tail.trimEnd(),
      '```',
    );
  }
  lines.push('In the summary, name the checks you ran and their result.');
  lines.push(
    'The server runs every declared check after the implement-improve pass, before code review; a failed check stops the run there.',
  );
  return lines.join('\n');
}

/** Append the current environment policy without rewriting task requirements or saved checklists. */
export function withEnvironment(prompt: string, note: string): string {
  return `${prompt.trimEnd()}\n\n${note}\n`;
}
