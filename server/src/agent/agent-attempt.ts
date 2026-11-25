import type { ChatUsage } from '../history/chat-usage.repository';
import { type DecisionWatch, hasModelDecision, type ModelPrice, noteDecision, priceTokens } from './limits';
import { sinceRecorded } from './since-recorded';
import { readStreamLine, type ModelUsage, type OwnUsage, type StreamPiece, takeAnswer } from './stream';
import { addGuessedLine, emptyUsageGuess } from './stream-guess';

interface AttemptBilling {
  model: string;
  prices: Record<string, ModelPrice>;
  /** The chat's previous reported session totals. A result line that reports the whole session is taken against them. */
  prior: ChatUsage;
}

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

  constructor(private readonly billing: AttemptBilling) {}

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
  }

  /** Applies the trailing partial line after the process has exited. */
  flush(buffer: string): void {
    if (buffer !== '') {
      this.decision = noteDecision(this.decision, readStreamLine(buffer));
    }
  }

  billed(): AttemptUsage {
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

  /** Each model of the result line at its own price; a model with no price row is priced as the launch's model. */
  private pricedByModel(): number {
    const { model, prices } = this.billing;
    return this.ownByModel.reduce((total, entry) => {
      const { input, output, cacheRead, cacheWrite } = entry;
      const own = priceTokens(entry.model, input, output, prices, cacheRead, cacheWrite);
      return total + (entry.usd ?? own ?? priceTokens(model, input, output, prices, cacheRead, cacheWrite) ?? 0);
    }, 0);
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
