import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { listRunEntries, runFileOwner } from '../core/run-files';
import type { RunEntity } from '../history/entities';
import { removeTreeAsync, root } from '../history/run-paths';
import { RunRepository } from '../history/run.repository';
import { RunFolders } from './run-folders';
import { runFinish } from './run-finished';

const DAY_MS = 86_400_000;

/** What one pass does for a run: whether its files go, and the entries of `data/` that are its files. */
interface Pass {
  run: RunEntity;
  at: number;
  aged: boolean;
  entries: string[];
}

/**
 * Takes the worktrees, agent state and /tmp folders of a finished run, and its output files, check outputs and logs
 * once it finished long ago. A run is finished by the one rule of `runFinish`; a merged, closed or skipped run is freed
 * at once, the rest after its age. A run that is not finished keeps everything. The rows, documents, events, branches,
 * refs, sessions and the stored chat ids stay, so a run can always be picked up again.
 */
@Injectable()
export class RunRetention {
  private readonly logger = new Logger(RunRetention.name);

  constructor(
    private readonly runs: RunRepository,
    private readonly folders: RunFolders,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /**
   * Frees every merged, closed or skipped run at once, frees every other finished run that finished more than `days`
   * ago, and removes the files of finished runs that finished more than `days` ago. 0 keeps the done runs and all files.
   * Then removes the /tmp folder of a run that no longer exists. Lists the runs where something was removed.
   */
  async apply(days: number, except?: string): Promise<string[]> {
    const cleaned: string[] = [];
    for (const pass of await this.passes(days, except)) {
      if (await this.clean(pass.run, pass.aged, pass.entries)) {
        cleaned.push(pass.run.key);
      }
    }
    await this.folders.removeLeftTmp();
    return cleaned;
  }

  /** Cleans the oldest finished run that is at least a day old. Null when there is none. A run with only files left frees no disk. */
  async cleanOldest(except: string): Promise<string | null> {
    for (const pass of await this.passes(1, except)) {
      if (pass.run.workspace !== 'removed' && (await this.clean(pass.run, pass.aged, pass.entries))) {
        return pass.run.key;
      }
    }
    return null;
  }

  /** Frees the folders of one run now, through the one removal. A held run is left alone: false. */
  async free(run: RunEntity): Promise<boolean> {
    return !this.runs.held(run) && (await this.clean(run, false, []));
  }

  /**
   * The one gate, never a held run or `except`: a finished run whose workspace is not removed and which is settled
   * or old enough, and a finished run old enough whose files are still there. The files are listed before the runs
   * are read, because a run's row exists before any file of it.
   */
  private async passes(days: number, except?: string): Promise<Pass[]> {
    const entries = days > 0 ? await listRunEntries(root(this.config)) : [];
    const runs = await this.runs.listRuns();
    const byId = new Map(runs.map((run) => [run.id, run]));
    const files = ownedFiles(entries, new Set(runs.map((run) => run.key)));
    const limit = this.clock.now() - days * DAY_MS;
    const passes: Pass[] = [];
    for (const run of runs) {
      const finish = run.key === except || this.runs.held(run) ? null : runFinish(run, byId);
      const aged = finish !== null && days > 0 && finish.at <= limit;
      if (finish && (aged || (finish.settled && run.workspace !== 'removed'))) {
        passes.push({ run, at: finish.at, aged, entries: files.get(run.key) ?? [] });
      }
    }
    return passes.sort((a, b) => a.at - b.at);
  }

  /**
   * A failure is logged and the run stays as it was marked, so one run does not stop the others. The folders go
   * when they are still there; the files go with them when `aged`.
   */
  private async clean(run: RunEntity, aged: boolean, entries: readonly string[]): Promise<boolean> {
    try {
      const freed = run.workspace === 'removed';
      if (!freed) {
        await this.folders.remove(run.key);
      }
      for (const entry of aged ? entries : []) {
        await removeTreeAsync(join(root(this.config), 'data', entry));
      }
      if (!freed) {
        await this.runs.markWorkspaceRemoved(run.key);
      }
      return !freed || (aged && entries.length > 0);
    } catch (error) {
      this.logger.warn(`retention of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

/** The output files, check outputs and log folders of each run, by the one matcher. Sessions and launches stay. */
function ownedFiles(entries: readonly string[], keys: ReadonlySet<string>): Map<string, string[]> {
  const files = new Map<string, string[]>();
  for (const entry of entries) {
    const owner = runFileOwner(entry, keys);
    if (owner && owner.kind !== 'session' && owner.kind !== 'launches') {
      files.set(owner.key, [...(files.get(owner.key) ?? []), entry]);
    }
  }
  return files;
}
