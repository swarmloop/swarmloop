import { type DecisionWatch, hasModelDecision, type ModelPrice, noteDecision, priceTokens, turnUsd } from './limits';
import { addGuessedLine, emptyUsageGuess, readStreamLine, type StreamPiece, takeAnswer } from './stream';

interface AttemptBilling {
  model: string;
  prices: Record<string, ModelPrice>;
  /** Dollars already recorded for this chat before this attempt. */
  groupUsd: number;
  resumed: boolean;
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
  private decision: DecisionWatch = { text: '', locked: false, stream: false, plain: false };
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
    this.decision = noteDecision(this.decision, piece, line);
    return piece;
  }

  /** Adds a piece from `ingest` to the usage and the answer. The caller runs this after the session write, as the stream order requires. */
  count(piece: StreamPiece): void {
    this.endedAfterResult ||= this.resultSeen && piece.taskEnded;
    this.noteBeforeResult(piece);
    this.resultSeen ||= piece.stops;
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
      this.decision = noteDecision(this.decision, readStreamLine(buffer), buffer);
    }
  }

  billed(): AttemptUsage {
    const { model, prices, groupUsd, resumed } = this.billing;
    if (!this.billedFromStream) {
      return {
        tokensIn: this.guess.tokensIn,
        tokensOut: this.guess.tokensOut,
        usd: priceTokens(model, this.guess.tokensIn, this.guess.tokensOut, prices) ?? 0,
      };
    }
    const priced = priceTokens(model, this.tokensIn, this.tokensOut, prices, this.cacheRead, this.cacheWrite) ?? 0;
    return {
      tokensIn: this.tokensIn + this.cacheRead + this.cacheWrite,
      tokensOut: this.tokensOut,
      usd: turnUsd(this.reportedUsd, priced, groupUsd, resumed),
    };
  }

  decided(): boolean {
    return hasModelDecision(this.decision);
  }

  /** A background task ended after the result line, and the answer lacks one of the sections the step needs. */
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

  private add(current: number, next: number | null, addUsage: boolean): number {
    if (next === null) {
      return current;
    }
    this.billedFromStream = true;
    return addUsage ? current + next : next;
  }
}
