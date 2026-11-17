import type { SandboxMount } from '../core/sandbox-mount';
import type { CheckCommandRepository } from '../history/check-command.repository';
import type { DocumentRepository } from '../history/document.repository';
import type { CheckCommandEntity } from '../history/entities';
import type { LiveHub } from '../live/live.hub';
import { git } from '../git/git';
import { checkNames } from './check-names';
import { checkRun, type CheckEntry } from './environment-config';
import { readPasses, type CommandPass, type VisitStart } from './check-passes';
import type { EnvironmentInput, EnvironmentRecord, FailedCommand, PreparedEnvironment } from './environment-types';

const CHECKS_SKIPPED = 'checks_skipped';

interface RowDeps {
  documents: Pick<DocumentRepository, 'putDocument' | 'latestBody'>;
  commands: Pick<CheckCommandRepository, 'add'>;
  live?: Pick<LiveHub, 'log'>;
}

function pathsOf(entry: CheckEntry): string[] | undefined {
  return typeof entry === 'string' ? undefined : entry.paths;
}

/** The pathspec that leaves out every `paths` list: what it selects lies outside all of them. */
function outsideLists(entries: CheckEntry[]): string[] {
  return ['.', ...entries.flatMap((entry) => (pathsOf(entry) ?? []).map((path) => `:(exclude)${path}`))];
}

/**
 * True when a change lies outside every `paths` list: a file nothing names may be read by any command, so no path skip
 * applies. `diff` is what `git diff --name-only` compares; `untracked` adds the files git does not track yet.
 */
async function changedOutsideLists(
  mount: SandboxMount,
  entries: CheckEntry[],
  diff: string[],
  untracked: boolean,
): Promise<boolean> {
  const at = ['-C', mount.hostPath];
  const spec = outsideLists(entries);
  return Boolean(
    (await git([...at, 'diff', '--name-only', ...diff, '--', ...spec])) ||
    (untracked && (await git([...at, 'ls-files', '--others', '--exclude-standard', '--', ...spec]))),
  );
}

/**
 * Why a command does not run: its `paths` (git pathspecs) match no change of the run against the commit its environment
 * was frozen at, tracked or untracked, and no change lies outside every list. Null when it runs: no paths, named by the
 * last return, no base, or a change outside the lists.
 */
async function untouchedPaths(
  mount: SandboxMount,
  record: EnvironmentRecord,
  entry: CheckEntry,
  named: boolean,
): Promise<string | null> {
  const paths = pathsOf(entry);
  if (!paths || named || !record.ref) {
    return null;
  }
  const at = ['-C', mount.hostPath];
  const changed =
    (await git([...at, 'diff', '--name-only', record.ref, '--', ...paths])).trim() ||
    (await git([...at, 'ls-files', '--others', '--exclude-standard', '--', ...paths])).trim();
  return changed || (await changedOutsideLists(mount, record.config.checks, [record.ref], true))
    ? null
    : `no change under ${paths.join(', ')}`;
}

/**
 * Why a command does not run: it passed earlier in this run on files that are the same under its `paths`. Every part
 * of that must hold: the same generation, image, command, setup and hosts, not named by the last return, and no
 * difference between the tree it passed on and the tree this visit starts on, under its `paths` or outside every list.
 * Null when it runs, also when any part cannot be read.
 */
async function passedOnSameFiles(args: {
  input: EnvironmentInput;
  mount: SandboxMount;
  record: EnvironmentRecord;
  entry: CheckEntry;
  named: boolean;
  start: VisitStart | null;
  pass: CommandPass | undefined;
}): Promise<string | null> {
  const { input, mount, record, entry, named, start, pass } = args;
  const paths = pathsOf(entry);
  if (!paths || named || !start || !pass) {
    return null;
  }
  const same =
    pass.generation === input.run.generation &&
    pass.imageId === start.imageId &&
    JSON.stringify(pass.check) === JSON.stringify(entry) &&
    pass.setup === record.setup?.command &&
    JSON.stringify(pass.hosts) === JSON.stringify(record.config.hosts);
  if (!same) {
    return null;
  }
  try {
    const diff = [pass.tree, start.tree];
    const under = await git(['-C', mount.hostPath, 'diff', '--name-only', ...diff, '--', ...paths]);
    return under || (await changedOutsideLists(mount, record.config.checks, diff, false))
      ? null
      : `passed on these files at ${pass.at}`;
  } catch {
    return null;
  }
}

/**
 * The rows of one repository's commands, one per entry at `offset + position`. `skipped` marks every row skipped (the
 * fingerprint skip). Otherwise a command is skipped too when its paths the diff does not touch, or when it passed
 * earlier on the same files under its paths, with its reason in a `checks` document and the live log. Those names, and
 * the reasons of the second kind, are stored for the pipeline step. Returns the rows that run and how many commands
 * the paths skipped.
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
    /** What this visit starts on, null when it cannot be read: no command is then skipped for having passed. */
    start: VisitStart | null;
  },
): Promise<{ rows: CheckCommandEntity[]; byPaths: number }> {
  const { input, mount, prepared, named, skipped, offset, start } = args;
  const { record } = prepared;
  const entries = record.config.checks;
  const names = checkNames(entries);
  const rows: CheckCommandEntity[] = [];
  const skippedNames: string[] = [];
  const passed: Record<string, string> = {};
  const passes = skipped || !start ? {} : await readPasses(deps.documents, input.key, record.repo);
  for (const [at, entry] of entries.entries()) {
    const command = checkRun(entry);
    const last = named.some((item) => item.repo === record.repo && item.command === command);
    const frozen = skipped ? null : await untouchedPaths(mount, record, entry, last);
    const same =
      skipped || frozen
        ? null
        : await passedOnSameFiles({ input, mount, record, entry, named: last, start, pass: passes[command] });
    const reason = frozen ?? same;
    if (same) {
      passed[names[at]] = same;
    }
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
      JSON.stringify({ names: skippedNames, ...(Object.keys(passed).length > 0 ? { passed } : {}) }),
    );
  }
  return { rows, byPaths: skippedNames.length };
}
