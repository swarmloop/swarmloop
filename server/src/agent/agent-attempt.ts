import type { Logger } from '@nestjs/common';
import { type DecisionWatch, findPrice, hasModelDecision, type ModelPrice, noteDecision, priceTokens } from './limits';
import { sinceRecorded, type ChatUsage } from './since-recorded';
import { type PricedRequest, RequestLedger, type RequestUsage } from './request-usage';
import { partOfTotal, readStreamLine, type StreamPiece, takeAnswer } from './stream';
import type { ModelUsage, OwnUsage } from './stream-usage';
import { addGuessedLine, emptyUsageGuess } from './stream-guess';

interface AttemptBilling {
  model: string;
  prices: Record<string, ModelPrice>;
  /** The chat's previous reported session totals. A result line that reports the whole session is taken against them. */
  prior: ChatUsage;
  /** Where a gap between the summed requests and the final line is logged. */
  logger?: Logger;
  /** Tells this launch's synthetic request ids from those of the other launches of one call. */
  idPrefix?: string;
}

/** A gap between the summed requests and the final line that is worth a log line, in dollars. */
const CROSS_CHECK_GAP_USD = 0.01;

interface AttemptUsage {
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

/** Reads the stream of one attempt into its usage, its answer text, and the model decision. */
export class AttemptMeter {
  private tokensIn = 0;
  private tokensOut = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private readonly guess = emptyUsageGuess();
  private billedFromStream = false;
  private reportedUsd: number | null = null;
  /** The counted usage came from a result line, which covers a whole session. */
  private fromResult = false;
  private own: OwnUsage | null = null;
  private ownByModel: ModelUsage[] = [];
  private decision: DecisionWatch = { text: '', locked: false };
  private responseText = '';
  private answerLocked = false;
  private resultSeen = false;
  private endedAfterResult = false;
  private backgroundEnded = false;
  private contentBeforeResult = false;
  private readonly ledger: RequestLedger;
  /** The final line's one request per model, when the stream carried no request of its own (Cursor). */
  private readonly fallback: RequestLedger;
  private crossChecked = false;

  constructor(
    private readonly billing: AttemptBilling,
    private readonly onRequest?: (request: PricedRequest) => void,
  ) {
    this.ledger = new RequestLedger(billing.prices, billing.model, billing.idPrefix);
    this.fallback = new RequestLedger(billing.prices, billing.model);
  }

  /** Notes the decision in one complete stream line. Returns the parsed piece, or null when the line is not a stream event. */
  ingest(line: string): StreamPiece | null {
    const piece = readStreamLine(line);
    this.decision = noteDecision(this.decision, piece);
    return piece;
  }

  /** Adds a piece from `ingest` to the usage and the answer. The caller runs this after the session write, as the stream order requires. */
  count(piece: StreamPiece): void {
    this.endedAfterResult ||= this.resultSeen && piece.taskEnded;
    this.noteBeforeResult(piece);
    this.resultSeen ||= piece.stops;
    this.noteResultUsage(piece);
    this.tokensIn = this.add(this.tokensIn, piece.tokensIn, piece.addUsage);
    this.tokensOut = this.add(this.tokensOut, piece.tokensOut, piece.addUsage);
    this.cacheRead = this.add(this.cacheRead, piece.cacheRead, piece.addUsage);
    this.cacheWrite = this.add(this.cacheWrite, piece.cacheWrite, piece.addUsage);
    if (piece.reportedUsd !== null) {
      this.reportedUsd = piece.reportedUsd;
      this.billedFromStream = true;
    }
    if (!this.billedFromStream) {
      addGuessedLine(this.guess, piece);
    }
    if (piece.text || piece.finalMessage) {
      const next = takeAnswer(this.responseText, this.answerLocked, piece);
      this.responseText = next.text;
      this.answerLocked = next.locked;
    }
    this.noteRequest(piece);
    this.crossCheck(piece);
  }

  /** The call's requests per model and per helper at the launch's prices. Without per-request usage: the final line's. */
  requestUsage(): RequestUsage {
    return (this.ledger.size > 0 ? this.ledger : this.fallback).usage();
  }

  /**
   * Runs after the process exited. A stream with no per-request usage (Cursor) counts its final line as the call's
   * requests, one per model it names, so that `onRequest` sees them.
   */
  settle(): void {
    if (this.ledger.size > 0 || this.fallback.size > 0) {
      return;
    }
    for (const request of this.finalLineRequests()) {
      this.fallback.put(request);
      this.onRequest?.(request);
    }
  }

  /** Applies the trailing partial line after the process has exited. */
  flush(buffer: string): void {
    if (buffer !== '') {
      this.decision = noteDecision(this.decision, readStreamLine(buffer));
    }
  }

  /** The summed requests whenever the stream carried any; otherwise what the final line or the guess says. */
  billed(): AttemptUsage {
    if (this.ledger.size === 0) {
      return this.finalLine();
    }
    const totals = this.ledger.totals();
    // Requests the price table cannot price must not turn a cost the CLI reported into $0.
    const reported = this.own !== null || this.fromResult;
    return this.ledger.hasUnpriced() && reported ? { ...totals, usd: this.finalLine().usd } : totals;
  }

  private finalLine(): AttemptUsage {
    const { model, prices } = this.billing;
    if (!this.billedFromStream) {
      return {
        tokensIn: this.guess.tokensIn,
        tokensOut: this.guess.tokensOut,
        usd: priceTokens(model, this.guess.tokensIn, this.guess.tokensOut, prices) ?? 0,
      };
    }
    if (this.own) {
      const { input, output, cacheRead, cacheWrite, usd } = this.own;
      return {
        tokensIn: input + cacheRead + cacheWrite,
        tokensOut: output,
        usd: usd ?? this.pricedByModel(),
      };
    }
    const totals = this.totals();
    const { prior } = this.billing;
    if (!this.fromResult) {
      return totals;
    }
    return {
      tokensIn: sinceRecorded(totals.tokensIn, prior.tokensIn),
      tokensOut: sinceRecorded(totals.tokensOut, prior.tokensOut),
      usd: sinceRecorded(totals.usd, prior.usd),
    };
  }

  /** The final line's own part per model, or the session total less the chat's previous totals, as priced requests. */
  private finalLineRequests(): PricedRequest[] {
    if (this.own) {
      return this.ownByModel.map((entry) => this.fallbackRequest(entry.model, entry, this.entryUsd(entry)));
    }
    if (!this.fromResult) {
      return [];
    }
    const total = {
      input: this.tokensIn,
      output: this.tokensOut,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      reportedUsd: this.reportedUsd,
    };
    const prompt = this.tokensIn + this.cacheRead + this.cacheWrite;
    const part = partOfTotal(total, prompt, this.billing.prior);
    return [this.fallbackRequest(this.billing.model, part, this.finalLine().usd)];
  }

  private fallbackRequest(
    model: string,
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
    usd: number,
  ): PricedRequest {
    const { input, output, cacheRead, cacheWrite } = tokens;
    return {
      messageId: `${this.billing.idPrefix ?? ''}final:${model}`,
      model,
      parentToolUseId: null,
      input,
      cacheRead,
      cacheWrite,
      output,
      usd,
      price: findPrice(model, this.billing.prices),
    };
  }

  /** One model's cost in the result line, or the price table's for it; a model with no price row is priced as the launch's model. */
  private entryUsd(entry: ModelUsage): number {
    const { model, prices } = this.billing;
    const { input, output, cacheRead, cacheWrite } = entry;
    const own = priceTokens(entry.model, input, output, prices, cacheRead, cacheWrite);
    return entry.usd ?? own ?? priceTokens(model, input, output, prices, cacheRead, cacheWrite) ?? 0;
  }

  /** Each model of the result line at its own price. */
  private pricedByModel(): number {
    return this.ownByModel.reduce((total, entry) => total + this.entryUsd(entry), 0);
  }

  /** The session totals of the last result line, also from a line that reports the visit's own part. Null when there is none. */
  reported(): AttemptUsage | null {
    return this.fromResult ? this.totals() : null;
  }

  private totals(): AttemptUsage {
    const { model, prices } = this.billing;
    const priced = priceTokens(model, this.tokensIn, this.tokensOut, prices, this.cacheRead, this.cacheWrite) ?? 0;
    return {
      tokensIn: this.tokensIn + this.cacheRead + this.cacheWrite,
      tokensOut: this.tokensOut,
      usd: this.reportedUsd ?? priced,
    };
  }

  /** The model already sent a result block that `answered` accepts. */
  decided(answered: ((text: string) => boolean) | undefined): boolean {
    return hasModelDecision(this.decision, answered);
  }

  /** A background task ended after the result line, and the answer has no valid result block. */
  backgroundKilled(answered: ((text: string) => boolean) | undefined): boolean {
    return this.endedAfterResult && answered !== undefined && !answered(this.responseText);
  }

  /** By structure, not wording: only stopped or killed background events, then an empty result. */
  orphanOnly(): boolean {
    return this.resultSeen && this.backgroundEnded && !this.contentBeforeResult && this.responseText.trim() === '';
  }

  answer(): string {
    return this.responseText;
  }

  private noteRequest(piece: StreamPiece): void {
    const request = piece.request ? this.ledger.add(piece.request) : null;
    if (request) {
      this.onRequest?.(request);
    }
  }

  /** The final line only cross-checks the summed requests: a gap of a cent or more is logged once. */
  private crossCheck(piece: StreamPiece): void {
    const reported = this.own !== null || this.fromResult;
    if (!piece.result || piece.addUsage || this.crossChecked || this.ledger.size === 0 || !reported) {
      return;
    }
    const line = this.finalLine().usd;
    const summed = this.ledger.totals().usd;
    if (Math.abs(line - summed) >= CROSS_CHECK_GAP_USD) {
      this.crossChecked = true;
      this.billing.logger?.warn(
        `The final line of the call says $${line.toFixed(4)}; its ${this.ledger.size} requests sum to $${summed.toFixed(4)}`,
      );
    }
  }

  private noteBeforeResult(piece: StreamPiece): void {
    if (this.resultSeen || piece.result) {
      return;
    }
    if (piece.backgroundEvent === 'ended') {
      this.backgroundEnded = true;
    } else if (piece.backgroundEvent === 'other' || piece.guessKind !== 'none' || piece.text !== null) {
      this.contentBeforeResult = true;
    }
  }

  /** A result line holds the session's totals, or the visit's own usage when it reports that apart. A Codex turn is always its own. */
  private noteResultUsage(piece: StreamPiece): void {
    if (!piece.result || piece.addUsage) {
      return;
    }
    this.own = piece.own ?? this.own;
    this.ownByModel = piece.own ? piece.ownByModel : this.ownByModel;
    this.billedFromStream ||= piece.own !== null;
    this.fromResult ||= piece.tokensIn !== null || piece.tokensOut !== null || piece.reportedUsd !== null;
  }

  private add(current: number, next: number | null, addUsage: boolean): number {
    if (next === null) {
      return current;
    }
    this.billedFromStream = true;
    return addUsage ? current + next : next;
  }
}
