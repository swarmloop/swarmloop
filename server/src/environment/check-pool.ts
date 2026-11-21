import type { Clock } from '../core/clock';
import { checkOutputPath } from '../core/check-output';
import { STOP_NOTE } from '../contract/run-state';
import { SwarmloopError } from '../core/swarmloop-error';
import type { CheckCommandRepository } from '../history/check-command.repository';
import type { DocumentRepository } from '../history/document.repository';
import type { CheckCommandEntity } from '../history/entities';
import type { LiveHub } from '../live/live.hub';
import type { CheckedRepo, EnvironmentInput } from './environment-types';
import { CheckSlots } from './check-slots';
import { CheckCapacity } from './check-capacity';
import type { CpuSlice } from '../sandbox/sandbox-types';
import { liveSamples, runShell, type ShellDeps } from './run-shell';

const GB = 1024 ** 3;

interface CheckPoolDeps {
  checksParallel: () => number;
  /** Reads the cores Docker has, so the places that fit are known before a command takes one. */
  readCores?: () => Promise<{ cpus: number } | undefined>;
  clock: Clock;
  documents: Pick<DocumentRepository, 'putDocument'>;
  commands: Pick<CheckCommandRepository, 'save'>;
  live?: Pick<LiveHub, 'changed' | 'log'>;
  halted?: (key: string) => boolean;
  shell: () => ShellDeps;
}

type CheckResult = { exitCode: number; tail: string };

/** What a command that waits for a free place shows. */
export function waitingText(ahead: number): string {
  return `waiting for a free check slot (${ahead} ahead)`;
}

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
 * Runs a check command. When its container ran out of memory it runs once more under the same cap. A kill by a Stop
 * is not a memory kill, so it is never run again.
 */
export async function runOnceMore(
  deps: ShellDeps,
  input: EnvironmentInput,
  launch: CheckedRepo['prepared']['launch'],
  command: string,
  mount: CheckedRepo['mount'],
  check?: { index: number; file: string; name?: string },
  place?: number,
  cpuSlice?: CpuSlice | null,
): Promise<Awaited<ReturnType<typeof runShell>>> {
  const first = await runShell(deps, input, launch, command, mount, 'checks', check, undefined, place, cpuSlice);
  if (first.outOfMemoryBytes === undefined) {
    return first;
  }
  return runShell(deps, input, launch, command, mount, 'checks', check, undefined, place, cpuSlice);
}

/** A Stop took check commands out of the line before they started: the checks did not run. */
export class ChecksStopped extends SwarmloopError {
  constructor() {
    super(STOP_NOTE);
  }
}

/** Runs the check commands of every repository, and runs a command that ran out of memory once more. */
export class CheckPool {
  private readonly slots: CheckSlots;
  private readonly capacity: CheckCapacity;

  constructor(private readonly deps: CheckPoolDeps) {
    this.capacity = new CheckCapacity(deps.checksParallel, deps.readCores);
    this.slots = new CheckSlots(() => this.capacity.places(), deps.halted);
  }

  /** Takes the waiting commands of a run out of the line, so they never start. */
  stopWaiting(key: string): void {
    this.slots.drop(key);
  }

  /** Runs `fn` in a place of the line. Null when a Stop took the command out of the line. */
  async withPlace<T>(
    input: EnvironmentInput,
    onAhead: (ahead: number) => void,
    fn: (place: number, cpuSlice?: CpuSlice | null) => Promise<T>,
  ): Promise<T | null> {
    try {
      if (this.deps.readCores) await this.capacity.enter();
      const taken = await this.slots.take(input.key, onAhead);
      if (!taken) return null;
      try {
        return await fn(taken.place, this.capacity.slice(taken.place));
      } finally {
        taken.release();
      }
    } finally {
      if (this.deps.readCores) this.capacity.leave();
    }
  }

  /**
   * Runs the commands of every repository in the one line of places of the whole server: the checks that fit on the cores, at most CHECKS_PARALLEL. Waits for all
   * of them, then throws the first error, or ChecksStopped when a Stop took a command out of the line.
   */
  async runAll(input: EnvironmentInput, attemptId: string, repos: CheckedRepo[]): Promise<void> {
    const jobs = repos.flatMap((repo) => repo.rows.map((row) => ({ repo, row })));
    const errors: unknown[] = [];
    this.deps.live?.changed(input.key);
    let stopped = false;
    const run = async (job: (typeof jobs)[number]): Promise<void> => {
      try {
        const result = await this.runCommand(input, attemptId, job.repo, job.row);
        if (result) {
          job.repo.results[job.repo.rows.indexOf(job.row)] = result;
        } else {
          stopped = true;
        }
      } catch (error) {
        errors.push(error);
      }
    };
    await Promise.all(jobs.map(run));
    if (stopped) {
      throw new ChecksStopped();
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  private async runCommand(
    input: EnvironmentInput,
    attemptId: string,
    repo: CheckedRepo,
    row: CheckCommandEntity,
  ): Promise<CheckResult | null> {
    return this.withPlace(
      input,
      (ahead) => this.waiting(input, row, ahead),
      (place, cpuSlice) => this.runInPlace(input, attemptId, repo, row, place, cpuSlice),
    );
  }

  private waiting(input: EnvironmentInput, row: CheckCommandEntity, ahead: number): void {
    this.deps.live?.log({
      key: input.key,
      step: input.step,
      command: row.commandIndex,
      samples: liveSamples(input.samples ?? []),
      body: `${waitingText(ahead)}\n`,
    });
  }

  private async runInPlace(
    input: EnvironmentInput,
    attemptId: string,
    repo: CheckedRepo,
    row: CheckCommandEntity,
    place: number,
    cpuSlice?: CpuSlice | null,
  ): Promise<CheckResult> {
    const { clock, shell } = this.deps;
    await this.mark(input, row, { status: 'running', startedAt: clock.iso() });
    const name = row.name ?? row.command;
    let outcome: Awaited<ReturnType<typeof runOnceMore>>;
    try {
      outcome = await runOnceMore(
        shell(),
        input,
        repo.prepared.launch,
        row.command,
        repo.mount,
        {
          index: row.commandIndex,
          name,
          file: checkOutputPath(shell().root, input.key, input.step, attemptId, row.commandIndex),
        },
        place,
        cpuSlice,
      );
    } catch (error) {
      await this.mark(input, row, { status: 'failed', endedAt: clock.iso() });
      throw error;
    }
    const killedAt = outcome.outOfMemoryBytes;
    const result: CheckResult = {
      exitCode: outcome.exitCode,
      tail: killedAt === undefined ? outcome.tail : `ran out of memory at ${gigabytes(killedAt)} GB`,
    };
    await this.mark(input, row, {
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

  private async mark(
    input: EnvironmentInput,
    row: CheckCommandEntity,
    patch: Partial<CheckCommandEntity>,
  ): Promise<void> {
    await this.deps.commands.save(Object.assign(row, patch));
    this.deps.live?.changed(input.key);
  }
}
