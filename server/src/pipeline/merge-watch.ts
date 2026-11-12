import { Injectable, Logger } from '@nestjs/common';
import { IsNull, Not } from 'typeorm';
import type { MergeOutcome, MergedFact } from '../contract/run-state';
import { REASON } from '../contract/run-state';
import { Clock } from '../core/clock';
import type { RunEntity } from '../history/entities';
import { DocumentRepository } from '../history/document.repository';
import { EventRepository } from '../history/event.repository';
import { MERGE_WATCH_COUNTER } from '../history/loop-detail';
import { RunRepository } from '../history/run.repository';
import { deriveState } from '../history/run-state';
import { MergeRequestLookup } from '../steps/merge-request/merge-request-lookup';
import { parseMergeRequests } from '../steps/merge-request/merge-request-record';

const DAY_MS = 86_400_000;
/** How long a done run waits for its merge request to be merged or closed. */
const WAIT_DAYS = 30;

/** The commit page beside a request's page: `…/pull/7` and `…/-/merge_requests/7` have `…/commit/<sha>` and `…/-/commit/<sha>`. */
function commitUrl(requestUrl: string, sha: string | null): string | null {
  const match = /^(.+?)(\/-)?\/(?:pull|merge_requests)\/\d+\/?$/.exec(requestUrl);
  return sha && match ? `${match[1]}${match[2] ?? ''}/commit/${sha}` : null;
}

/**
 * Asks the code host, read-only, how the merge requests of the runs that are not working ended. A run whose requests
 * are all merged becomes `merged`; one with a request closed unmerged becomes `closed`. Whoever merged it counts. A
 * done run on a host that cannot be read stays done with a note, and the next pass tries again. A run that is stopped,
 * blocked, failed or waiting is left as it is until all its requests have ended, and then becomes done.
 */
@Injectable()
export class MergeWatch {
  private readonly logger = new Logger(MergeWatch.name);

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly events: EventRepository,
    private readonly lookup: MergeRequestLookup,
    private readonly clock: Clock,
  ) {}

  /** One pass over the runs that are not working and whose merge requests have not ended. */
  async run(): Promise<void> {
    for (const run of await this.runs.findRuns({ status: Not('running'), mergeOutcome: IsNull() })) {
      try {
        await (run.status === 'done' ? this.watch(run) : this.watchUnfinished(run));
      } catch (error) {
        this.logger.warn(`merge watch of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** `doneAt` is stored the first time the run is seen: a done run is rarely written again, so its `updatedAt` is close to it. */
  private async watch(run: RunEntity): Promise<void> {
    const doneAt = run.doneAt ?? run.updatedAt;
    if (this.clock.now() - Date.parse(doneAt) > WAIT_DAYS * DAY_MS) {
      await this.note(run, doneAt, {
        code: REASON.mergeWatchStopped,
        message: `The merge request was not merged or closed in ${WAIT_DAYS} days: swarmloop stopped watching it.`,
      });
      return;
    }
    const body = await this.documents.latestBody(run.key, 'merge_request');
    if (!body) return;
    let merge: MergeOutcome | null;
    try {
      merge = await this.read(run, parseMergeRequests(body));
    } catch (error) {
      await this.note(run, doneAt, {
        code: REASON.mergeWatchUnavailable,
        message: `The code host cannot be read, so the merge request is not watched: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (merge) {
      await this.runs.release(run, { status: 'done', doneAt, merge });
    } else if (run.doneAt !== doneAt || run.stateReason) {
      await this.runs.release(run, { status: 'done', doneAt });
    }
  }

  /**
   * A run that is not done is left as it is, and changes only when every request has ended: the outcome is written
   * with the run's state and the history line. A host that cannot be read, or a run not touched for 30 days, writes nothing.
   */
  private async watchUnfinished(run: RunEntity): Promise<void> {
    if (this.clock.now() - Date.parse(run.updatedAt) > WAIT_DAYS * DAY_MS) return;
    const body = await this.documents.latestBody(run.key, 'merge_request');
    if (!body) return;
    let merge: MergeOutcome | null;
    try {
      merge = await this.read(run, parseMergeRequests(body), false);
    } catch {
      return;
    }
    if (!merge) return;
    const released = await this.runs.release(run, { status: 'done', doneAt: this.clock.iso(), merge });
    if (released.status !== 'done') return;
    const ended = 'merged' in merge ? 'merged' : 'closed';
    const host = run.codeHost === 'github' ? 'GitHub' : 'GitLab';
    await this.events.recordLoop(
      run,
      MERGE_WATCH_COUNTER,
      0,
      `The merge request was ${ended} on ${host} while the run was ${run.state}; the run is done.`,
    );
  }

  /** Null while a request is open. A request closed unmerged settles the run at once, unless `settleAtOnce` is off. */
  private async read(
    run: RunEntity,
    records: { project: string; iid: number; url: string }[],
    settleAtOnce = true,
  ): Promise<MergeOutcome | null> {
    if (!run.codeHost) throw new Error('the run has no code host');
    const merged: Record<string, MergedFact> = {};
    let closed: MergeOutcome | null = null;
    let open = false;
    for (const { project, iid, url } of records) {
      const state = await this.lookup.state(run.codeHost, project, iid);
      if (state.state === 'closed') {
        closed ??= { closed: { repo: project, by: state.by, at: state.at } };
        if (settleAtOnce) return closed;
      } else if (state.state === 'open') open = true;
      else merged[project] = { sha: state.sha, by: state.by, at: state.at, url: commitUrl(url, state.sha) };
    }
    return open ? null : (closed ?? { merged });
  }

  /** Stores the note once: a pass that finds the same note writes nothing. */
  private async note(run: RunEntity, doneAt: string, reason: { code: string; message: string }): Promise<void> {
    if (run.doneAt === doneAt && deriveState(run).reason?.code === reason.code) return;
    await this.runs.release(run, { status: 'done', doneAt, reason });
  }
}
