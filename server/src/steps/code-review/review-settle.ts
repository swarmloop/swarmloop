import type { SwarmloopEnv } from '../../config/env';
import type { DocumentRepository } from '../../history/document.repository';
import type { EventRepository } from '../../history/event.repository';
import type { RunEntity } from '../../history/entities';
import type { DocumentDraft } from '../../history/visit';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { PipelineResult } from '../../core/pipeline-result';
import { RuntimeLimit } from '../../core/swarmloop-error';
import type { Requirement } from '../../contract/requirement-list';
import { isResultKind } from '../../agent-result/result-definition';
import type { StepContext } from '../base-step';
import { limitRoute } from '../shared/limit-failover';
import { stampGate } from '../shared/gate';
import { textDocument } from '../shared/handoff';
import { ARTIFACTS } from '../contract/artifacts';
import { opinionSummary } from './code-review-round-result';
import { askPerson, reviewAsks } from './review-ask';
import type { Exchange } from './review-exchange';
import { closeReview, failed, noteHandoff, writeReport } from './review-report';
import { othersOpen, routeReview, tallyRound } from './review-round';
import type { Finished, ReviewDeps } from './reviewer';
import type { Opinion } from './code-review-record';

/** What the round left and what the report needs, once the reviewers have answered. */
interface SettleInput {
  ctx: StepContext;
  deps: ReviewDeps;
  env: SwarmloopEnv;
  finished: Finished[];
  kept: Opinion[];
  recovered: DocumentDraft[];
  fingerprint: string;
  only: string | undefined;
  mounts: SandboxMount[];
  requirements: string;
  notes: string | null;
  impact: string | null;
  list: Requirement[] | null;
  exchanges: Map<string, Exchange>;
  fresh: boolean;
  thirdParty: boolean;
  same: boolean;
}

/** Ends the code-review visit after the reviewers: a limit, an error, a wait, an ask, or the routed report. */
export class ReviewSettle {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly events: EventRepository,
  ) {}

  async settle(input: SettleInput): Promise<PipelineResult> {
    const { ctx, deps, env, finished, kept, recovered, fingerprint, only } = input;
    const { mounts, requirements, notes, impact, list, exchanges, fresh, thirdParty, same } = input;
    const { opened, options } = ctx;
    const { key } = opened.run;
    const { reportContinued, opinions, stored, errors } = tallyRound(kept, recovered, finished);
    const limited = finished.find((item) => item.limit)?.limit;
    if (limited) {
      // The reviewers that answered keep their answers; the ones the limit stopped run again when the run goes on.
      const waiting = await closeReview(ctx, limitRoute(limited), `${opened.startedAt} ${limited.message}`, stored, []);
      await this.stamp(opened.run, stored, fingerprint);
      return waiting;
    }
    if (errors.length > 0) {
      const closed = await closeReview(ctx, failed(errors[0]), `${opened.startedAt} ${errors[0]}`, stored, []);
      await this.stamp(opened.run, stored, fingerprint);
      return closed;
    }
    const noted = await noteHandoff(this.documents, key, opinions, stored);
    if (only && othersOpen(only, opinions)) {
      const summary = opinionSummary(opinions);
      const waiting = await closeReview(
        ctx,
        { to: 'wait', reason: 'other reviewers are open' },
        `${opened.startedAt} code-review waiting\n${summary}`,
        noted,
        [],
      );
      await this.stamp(opened.run, stored, fingerprint);
      return waiting;
    }
    let written: Awaited<ReturnType<typeof writeReport>>;
    try {
      written = await writeReport(
        deps,
        opened,
        key,
        env,
        opinions,
        mounts,
        requirements,
        notes,
        impact,
        list,
        reportContinued,
        options.auto,
        options.answerErrors,
        exchanges,
      );
    } catch (error) {
      if (!(error instanceof RuntimeLimit)) {
        throw error;
      }
      const waiting = await closeReview(ctx, limitRoute(error), `${opened.startedAt} ${error.message}`, noted, []);
      await this.stamp(opened.run, stored, fingerprint);
      return waiting;
    }
    const reportExchanges = written.exchange ? [written.exchange] : [];
    if ('error' in written) {
      return closeReview(
        ctx,
        failed(written.error),
        `${opened.startedAt} ${written.error}`,
        [...noted, ...written.documents],
        reportExchanges,
        written.usage,
      );
    }
    const recorded = [...noted, ...written.documents];
    if (fresh) {
      recorded.push(textDocument(ARTIFACTS.rebaseConflict.kind, 'clear\n'));
    }
    const asks = thirdParty ? [] : reviewAsks(exchanges, finished, same, opened.startedAt);
    if (asks.length > 0) {
      const asked = await askPerson(ctx, asks, recorded, reportExchanges, written.usage);
      await this.stamp(opened.run, [...stored, ...written.documents], fingerprint);
      return asked;
    }
    const routed = await routeReview(
      this.events,
      ctx,
      opinions,
      recorded,
      written.exchange ? [written.exchange] : [],
      thirdParty,
      written.usage,
    );
    await this.stamp(opened.run, [...stored, ...written.documents], fingerprint);
    return routed;
  }

  /** The reviews this round stored count for the generation and the files they judged, once their visit is closed. */
  private async stamp(run: RunEntity, stored: DocumentDraft[], fingerprint: string): Promise<void> {
    for (const document of stored.filter((item) => !isResultKind(item.kind))) {
      await stampGate(this.documents, run, document.kind, fingerprint);
    }
  }
}
