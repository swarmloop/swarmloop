import type { Clock } from '../core/clock';
import { checkOutputPath } from '../core/check-output';
import { SwarmloopError } from '../core/swarmloop-error';
import type { CheckCommandRepository } from '../history/check-command.repository';
import type { DocumentRepository } from '../history/document.repository';
import type { CheckCommandEntity } from '../history/entities';
import { footprintOf } from '../sandbox/footprint';
import type { SandboxService } from '../sandbox/sandbox.service';
import type { CheckedRepo, EnvironmentInput } from './environment-types';
import { runShell, type ShellDeps } from './run-shell';

const GB = 1024 ** 3;

interface CheckPoolDeps {
  checksParallel: () => number;
  clock: Clock;
  sandbox: Pick<SandboxService, 'snapshot'>;
  documents: Pick<DocumentRepository, 'putDocument'>;
  commands: Pick<CheckCommandRepository, 'save'>;
  shell: () => ShellDeps;
}

type CheckResult = { exitCode: number; tail: string };

/** Gigabytes with at most one decimal and no trailing `.0`. */
function gigabytes(bytes: number): string {
  return String(Math.round((bytes / GB) * 10) / 10);
}

export function outOfMemoryError(repo: string, name: string, killedAt: number): SwarmloopError {
  return new SwarmloopError(
    `${repo} ${name} ran out of memory at ${gigabytes(killedAt)} GB: give Docker more memory or lower RESERVE_MEMORY_GB`,
    { category: 'environment' },
  );
}

/**
 * Runs a check command. When its container ran out of memory it runs once more alone, with the cap raised to what the
 * budget allows. A kill by a Stop is not a memory kill, so it is never run again.
 */
export async function runOnceMoreAlone(
  deps: ShellDeps,
  sandbox: Pick<SandboxService, 'snapshot'>,
  input: EnvironmentInput,
  launch: CheckedRepo['prepared']['launch'],
  command: string,
  mount: CheckedRepo['mount'],
  check?: { index: number; file: string; name?: string },
): Promise<Awaited<ReturnType<typeof runShell>>> {
  const first = await runShell(deps, input, launch, command, mount, 'checks', check);
  if (first.outOfMemoryBytes === undefined) {
    return first;
  }
  const seed = footprintOf('check', []).memoryBytes;
  const limits = { alone: true, memoryCapBytes: Math.max(sandbox.snapshot().capacityMemoryBytes, seed) };
  return runShell(deps, input, launch, command, mount, 'checks', check, undefined, limits);
}

/** Runs the check commands of every repository in a pool, and runs a command that ran out of memory once more alone. */
export class CheckPool {
  constructor(private readonly deps: CheckPoolDeps) {}

  /** Runs the commands of every repository in a pool of CHECKS_PARALLEL. Waits for all of them, then throws the first error. */
  async runAll(input: EnvironmentInput, attemptId: string, repos: CheckedRepo[]): Promise<void> {
    const jobs = repos.flatMap((repo) => repo.rows.map((row) => ({ repo, row })));
    const errors: unknown[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let job = jobs[next++]; job; job = jobs[next++]) {
        try {
          job.repo.results[job.repo.rows.indexOf(job.row)] = await this.runCommand(input, attemptId, job.repo, job.row);
        } catch (error) {
          errors.push(error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.deps.checksParallel(), jobs.length) }, worker));
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  private async runCommand(
    input: EnvironmentInput,
    attemptId: string,
    repo: CheckedRepo,
    row: CheckCommandEntity,
  ): Promise<CheckResult> {
    const { clock, shell } = this.deps;
    await this.mark(row, { status: 'running', startedAt: clock.iso() });
    const name = row.name ?? row.command;
    let outcome: Awaited<ReturnType<typeof runOnceMoreAlone>>;
    try {
      outcome = await runOnceMoreAlone(
        shell(),
        this.deps.sandbox,
        input,
        repo.prepared.launch,
        row.command,
        repo.mount,
        {
          index: row.commandIndex,
          name,
          file: checkOutputPath(shell().root, input.key, input.step, attemptId, row.commandIndex),
        },
      );
    } catch (error) {
      await this.mark(row, { status: 'failed', endedAt: clock.iso() });
      throw error;
    }
    const killedAt = outcome.outOfMemoryBytes;
    const result: CheckResult = {
      exitCode: outcome.exitCode,
      tail: killedAt === undefined ? outcome.tail : `ran out of memory at ${gigabytes(killedAt)} GB`,
    };
    await this.mark(row, {
      status: result.exitCode === 0 ? 'passed' : 'failed',
      exitCode: result.exitCode,
      endedAt: clock.iso(),
    });
    await this.deps.documents.putDocument(
      input.run,
      'checks',
      JSON.stringify({ repo: repo.prepared.record.repo, command: row.command, ...result }),
    );
    if (killedAt !== undefined) {
      throw outOfMemoryError(repo.prepared.record.repo, name, killedAt);
    }
    return result;
  }

  private async mark(row: CheckCommandEntity, patch: Partial<CheckCommandEntity>): Promise<void> {
    await this.deps.commands.save(Object.assign(row, patch));
  }
}
