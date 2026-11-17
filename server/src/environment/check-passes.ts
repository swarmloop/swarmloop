import type { SandboxMount } from '../core/sandbox-mount';
import type { Clock } from '../core/clock';
import type { DocumentRepository } from '../history/document.repository';
import { captureTree } from '../git/worktree-tree';
import { checksImageId } from './checks-fingerprint';
import { checkRun, type CheckEntry } from './environment-config';
import type { CheckedRepo, EnvironmentInput, PreparedEnvironment } from './environment-types';

/** One document per repository: the last pass of each of its commands, by command text. */
const COMMAND_PASSES = 'command_passes';

/** What one command passed on: the tree its visit started on and everything else that could change its answer. */
export interface CommandPass {
  tree: string;
  generation: number | undefined;
  imageId: string;
  check: CheckEntry;
  setup: string | undefined;
  hosts: unknown;
  at: string;
}

/** What a checks visit of one repository starts on. */
export interface VisitStart {
  tree: string;
  imageId: string;
}

interface PassDeps {
  clock: Pick<Clock, 'iso'>;
  documents: Pick<DocumentRepository, 'latestBody' | 'putDocument'>;
}

/** The tree and the image id this visit starts on. Null when either cannot be read: nothing is then skipped or kept. */
export async function visitStart(
  mount: SandboxMount,
  prepared: PreparedEnvironment,
  docker: (args: string[], timeoutMs?: number) => Promise<string>,
): Promise<VisitStart | null> {
  try {
    const captured = await captureTree(mount.hostPath);
    return captured ? { tree: captured.tree, imageId: await checksImageId(docker, prepared.launch.image) } : null;
  } catch {
    return null;
  }
}

export async function readPasses(
  documents: Pick<DocumentRepository, 'latestBody'>,
  key: string,
  repo: string,
): Promise<Record<string, CommandPass>> {
  const stored = await documents.latestBody(key, `${COMMAND_PASSES}:${repo}`);
  return stored ? ((JSON.parse(stored) as { commands: Record<string, CommandPass> }).commands ?? {}) : {};
}

function passFor(
  input: Pick<EnvironmentInput, 'run'>,
  prepared: PreparedEnvironment,
  entry: CheckEntry,
  start: VisitStart,
  at: string,
): CommandPass {
  const { record } = prepared;
  return {
    tree: start.tree,
    generation: input.run.generation,
    imageId: start.imageId,
    check: entry,
    setup: record.setup?.command,
    hosts: record.config.hosts,
    at,
  };
}

/**
 * Keeps the pass of each command of the repository that ran and exited 0, and drops the pass of one that did not.
 * A command that gave no result keeps what it had. Without a start nothing is kept, but failures still drop their pass.
 */
export async function recordPasses(
  deps: PassDeps,
  input: EnvironmentInput,
  repo: CheckedRepo,
  start: VisitStart | null,
): Promise<void> {
  const { prepared } = repo;
  const name = prepared.record.repo;
  const commands = await readPasses(deps.documents, input.key, name);
  const at = deps.clock.iso();
  for (const [index, row] of repo.rows.entries()) {
    const result = repo.results[index];
    const entry = prepared.record.config.checks.find((item) => checkRun(item) === row.command);
    if (!result || !entry) {
      continue;
    }
    if (result.exitCode === 0 && start) {
      commands[row.command] = passFor(input, prepared, entry, start, at);
    } else {
      delete commands[row.command];
    }
  }
  await deps.documents.putDocument(input.run, `${COMMAND_PASSES}:${name}`, JSON.stringify({ commands }));
}
