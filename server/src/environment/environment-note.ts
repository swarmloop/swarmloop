import type { EnvironmentRecord } from './project-environments';

/** The sentences that tell a blind agent not to run tests. With a project environment they are wrong. */
const NO_TESTS = [
  ' Tests run only in the GitLab or GitHub pipeline, never in this sandbox.',
  ' Do not run tests on this machine.',
  ' Do not run tests.',
];

/** CI configuration the commit step refuses; the agent is told in advance. */
export const CI_CONFIG_HINT = '`.github/workflows/`, `.github/actions/`, `.gitlab-ci.yml`, `.gitlab/`';

export function environmentNote(record: EnvironmentRecord): string {
  const { config } = record;
  const lines = [
    `# Project environment`,
    `This container runs in ${record.image ?? config.image ?? 'the project image'} from ${config.source} of ${record.repo}, with the project's own toolchain.`,
    'You may run any command in the working directory: build, lint, type check, tests, and the package manager. Package registries are reachable, so you can add or update a dependency; the lockfile it writes is committed with your work. There is no Docker, no database or other service, and no other network.',
  ];
  if (config.checks.length > 0) {
    lines.push(
      'Run these checks when a coherent piece of work is done and always before your final summary. When one fails, fix the cause and run it again. Do not run them after every small edit.',
      ...config.checks.map((check) => `- \`${check}\``),
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
  if (config.setup) {
    lines.push(`If a dependency or a generated file is missing, run the setup again: \`${config.setup}\`.`);
  }
  lines.push(`Do not change CI configuration (${CI_CONFIG_HINT}): the commit refuses it.`);
  const setup = record.setup;
  if (setup && setup.exitCode !== 0) {
    lines.push(
      `The setup \`${setup.command}\` failed with exit ${setup.exitCode}. Fix the cause when it is in the repository, or install what is missing yourself. Its last lines:`,
      '```',
      setup.tail.trimEnd(),
      '```',
    );
  }
  lines.push('In the summary, name the checks you ran and their result.');
  return lines.join('\n');
}

/** The prompt for an agent that has the toolchain: no ban on tests, and the environment block at the end. */
export function withEnvironment(prompt: string, note: string): string {
  let text = prompt;
  for (const sentence of NO_TESTS) {
    text = text.split(sentence).join('');
  }
  return `${text.trimEnd()}\n\n${note}\n`;
}
