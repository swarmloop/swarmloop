import { Injectable, Optional } from '@nestjs/common';
import { LiveHub } from '../../live/live.hub';

/** The reviewers an open code-review round launches, and where its report stands. Held in memory only. */
export interface OpenReviewRound {
  /** Reviewer names, such as `quality`. */
  reviewers: string[];
  reportDue: boolean;
  /** The report's own agent has started. */
  reportStarted: boolean;
}

/** The open code-review round of each run, so the run page shows as working only what the round runs. */
@Injectable()
export class OpenReviewRounds {
  private readonly rounds = new Map<string, OpenReviewRound>();

  constructor(@Optional() private readonly live?: LiveHub) {}

  /** Sets the round of a run, or refines the one already set. */
  open(key: string, round: OpenReviewRound): void {
    this.rounds.set(key, round);
    this.live?.changed(key);
  }

  reportStarted(key: string): void {
    const round = this.rounds.get(key);
    if (round) {
      this.rounds.set(key, { ...round, reportStarted: true });
      this.live?.changed(key);
    }
  }

  close(key: string): void {
    if (this.rounds.delete(key)) {
      this.live?.changed(key);
    }
  }

  of(key: string): OpenReviewRound | undefined {
    return this.rounds.get(key);
  }
}
