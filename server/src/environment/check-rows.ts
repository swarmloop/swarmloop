import type { SandboxMount } from '../core/sandbox-mount';
import type { CheckCommandRepository } from '../history/check-command.repository';
import type { DocumentRepository } from '../history/document.repository';
import type { CheckCommandEntity } from '../history/entities';
import type { LiveHub } from '../live/live.hub';
import { git } from '../git/git';
import { checkNames } from './check-names';
import { checkRun, type CheckEntry } from './environment-config';
import type { EnvironmentInput, EnvironmentRecord, FailedCommand, PreparedEnvironment } from './environment-types';

const CHECKS_SKIPPED = 'checks_skipped';

interface RowDeps {
  documents: Pick<DocumentRepository, 'putDocument'>;
  commands: Pick<CheckCommandRepository, 'add'>;
  live?: Pick<LiveHub, 'log'>;
}

/**
 * Why a command does not run: its `paths` (git pathspecs) match no change of the run against the commit its environment
 * was frozen at, tracked or untracked. Null when it runs: no paths, named by the last return, or no base.
 */
async function untouchedPaths(
  mount: SandboxMount,
  record: EnvironmentRecord,
  entry: CheckEntry,
  named: boolean,
): Promise<string | null> {
  const paths = typeof entry === 'string' ? undefined : entry.paths;
  if (!paths || named || !record.ref) {
    return null;
  }
  const at = ['-C', mount.hostPath];
  const changed =
    (await git([...at, 'diff', '--name-only', record.ref, '--', ...paths])).trim() ||
    (await git([...at, 'ls-files', '--others', '--exclude-standard', '--', ...paths])).trim();
  return changed ? null : `no change under ${paths.join(', ')}`;
}

/**
 * The rows of one repository's commands, one per entry at `offset + position`. `skipped` marks every row skipped (the
 * fingerprint skip). Otherwise a command whose paths the diff does not touch is skipped too, with its reason in a
 * `checks` document and the live log, and those names are stored for the pipeline step. Returns the rows that run and
 * how many commands the paths skipped.
 */
export async function addCheckRows(
  deps: RowDeps,
  args: {
    input: EnvironmentInput;
    mount: SandboxMount;
    prepared: PreparedEnvironment;
    named: FailedCommand[];
    skipped: boolean;
    offset: number;
  },
): Promise<{ rows: CheckCommandEntity[]; byPaths: number }> {
  const { input, mount, prepared, named, skipped, offset } = args;
  const { record } = prepared;
  const entries = record.config.checks;
  const names = checkNames(entries);
  const rows: CheckCommandEntity[] = [];
  const skippedNames: string[] = [];
  for (const [at, entry] of entries.entries()) {
    const command = checkRun(entry);
    const reason = skipped
      ? null
      : await untouchedPaths(
          mount,
          record,
          entry,
          named.some((item) => item.repo === record.repo && item.command === command),
        );
    const row = await deps.commands.add({
      runId: input.run.id,
      attemptId: input.run.activeAttempt ?? '',
      repo: record.repo,
      command,
      name: names[at],
      commandIndex: offset + at,
      ...(skipped || reason ? { status: 'skipped', skipped: 1, exitCode: 0 } : {}),
    });
    if (reason) {
      skippedNames.push(names[at]);
      const body = JSON.stringify({
        repo: record.repo,
        command,
        name: names[at],
        skipped: true,
        exitCode: 0,
        tail: reason,
      });
      await deps.documents.putDocument(input.run, 'checks', body);
      deps.live?.log({ key: input.key, step: input.step, body: `${names[at]}: ${reason}\n` });
    } else if (!skipped) {
      rows.push(row);
    }
  }
  // Written on every visit that judges paths, so a later visit that ran the command replaces an older skip.
  if (!skipped && entries.some((entry) => typeof entry !== 'string' && entry.paths)) {
    await deps.documents.putDocument(
      input.run,
      `${CHECKS_SKIPPED}:${record.repo}`,
      JSON.stringify({ names: skippedNames }),
    );
  }
  return { rows, byPaths: skippedNames.length };
}
