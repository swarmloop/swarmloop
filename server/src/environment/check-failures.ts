import type { Clock } from '../core/clock';
import type { DocumentRepository } from '../history/document.repository';
import type { CheckedRepo, CheckFailure, EnvironmentInput, PreparedEnvironment } from './environment-types';

const CHECKS_FAIL = 'checks_fail';

export interface FailureDeps {
  clock: Clock;
  documents: Pick<DocumentRepository, 'latestBody' | 'putDocument'>;
  fingerprint: (input: EnvironmentInput, prepared: PreparedEnvironment) => Promise<string>;
}

/** The tail of an output names its command, also when the output was long enough to push the command line out of it. */
export function withCommand(command: string, tail: string): string {
  return tail.startsWith(`$ ${command}`) ? tail : `$ ${command}\n${tail}`;
}

/** What went wrong in one repository: each failed command, and the files the commands changed. */
export async function failuresOf(
  deps: FailureDeps,
  input: EnvironmentInput,
  repo: CheckedRepo,
): Promise<CheckFailure[]> {
  const name = repo.prepared.record.repo;
  const failed = repo.rows.flatMap((row, at) => {
    const result = repo.results[at];
    return result && result.exitCode !== 0 ? [{ command: row.command, ...result }] : [];
  });
  const repeated = await recordFailures(
    deps,
    input,
    name,
    failed.map((item) => item.command),
    repo.fingerprint,
  );
  const failures: CheckFailure[] = failed.map((item) => ({
    repo: name,
    body: `${name}: required check failed (exit ${item.exitCode}):\n${withCommand(item.command, item.tail)}`,
    repeated: repeated.has(item.command)
      ? `${name}: ${item.command} failed again on unchanged files after a relaunch`
      : '',
    failed: { repo: name, command: item.command, tail: item.tail },
  }));
  if ((await deps.fingerprint(input, repo.prepared)) !== repo.fingerprint) {
    failures.push({
      repo: name,
      body: `${name}: required checks changed project files. Review those changes and rerun the checks before completing implementation.`,
      repeated: '',
    });
  }
  return failures;
}

/** Records the failed commands of a repository. Returns the ones that failed before on the same files. */
async function recordFailures(
  deps: FailureDeps,
  input: EnvironmentInput,
  repo: string,
  commands: string[],
  fingerprint: string,
): Promise<Set<string>> {
  if (commands.length === 0) {
    return new Set();
  }
  const stored = await deps.documents.latestBody(input.key, `${CHECKS_FAIL}:${repo}`);
  const last = stored ? (JSON.parse(stored) as { command?: string; commands?: string[]; fingerprint: string }) : null;
  const before = last?.fingerprint === fingerprint ? (last.commands ?? [last.command]) : [];
  await deps.documents.putDocument(
    input.run,
    `${CHECKS_FAIL}:${repo}`,
    JSON.stringify({
      command: commands[0],
      ...(commands.length > 1 ? { commands } : {}),
      fingerprint,
      step: input.step,
      at: deps.clock.iso(),
    }),
  );
  return new Set(commands.filter((command) => before.includes(command)));
}
