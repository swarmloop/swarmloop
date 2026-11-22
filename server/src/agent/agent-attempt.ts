import type { ChatUsage } from '../history/chat-usage.repository';
import { type DecisionWatch, hasModelDecision, type ModelPrice, noteDecision, priceTokens } from './limits';
import { sinceRecorded } from './since-recorded';
import { readStreamLine, type OwnUsage, type StreamPiece, takeAnswer } from './stream';
import { addGuessedLine, emptyUsageGuess } from './stream-guess';

interface AttemptBilling {
  model: string;
  prices: Record<string, ModelPrice>;
  /** What the chat already cost before this attempt. A result line that reports the whole session is taken against it. */
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
    const { model, prices, prior } = this.billing;
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
        usd: usd ?? priceTokens(model, input, output, prices, cacheRead, cacheWrite) ?? 0,
      };
    }
    const priced = priceTokens(model, this.tokensIn, this.tokensOut, prices, this.cacheRead, this.cacheWrite) ?? 0;
    const tokensIn = this.tokensIn + this.cacheRead + this.cacheWrite;
    if (!this.fromResult) {
      return { tokensIn, tokensOut: this.tokensOut, usd: this.reportedUsd ?? priced };
    }
    return {
      tokensIn: sinceRecorded(tokensIn, prior.tokensIn),
      tokensOut: sinceRecorded(this.tokensOut, prior.tokensOut),
      usd: sinceRecorded(this.reportedUsd ?? priced, prior.usd),
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
