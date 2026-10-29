import { readStreamLine, takeAnswer } from '../../limits/stream';
import { SwarmloopError } from '../../swarmloop-error';

export interface ReviewDecision {
  decision: 'ok' | 'return';
  body: string;
}

export function parseReview(text: string, fallback = ''): ReviewDecision {
  for (const source of [...sources(text), ...sources(fallback)]) {
    const decision = lastDecision(source);
    if (decision) {
      return { decision, body: `${source.trimEnd()}\n` };
    }
  }
  throw new SwarmloopError('decision is missing');
}

export function reviewDecision(text: string): 'ok' | 'return' | null {
  for (const source of sources(text)) {
    const decision = lastDecision(source);
    if (decision) {
      return decision;
    }
  }
  return null;
}

function sources(text: string): string[] {
  if (!text) {
    return [];
  }
  const stream = streamText(text);
  if (!stream || stream === text) {
    return [text];
  }
  // A later attempt is appended to the same file. The agent's stream is that attempt.
  return lastDecision(stream) ? [stream, text] : [text, stream];
}

function lastDecision(text: string): 'ok' | 'return' | null {
  let found: 'ok' | 'return' | null = null;
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^[`*]+/, '').replace(/[`*]+$/, '').trim();
    const match = /^decision:\s*(ok|return)\s*$/.exec(cleaned);
    if (match?.[1] === 'ok' || match?.[1] === 'return') {
      found = match[1];
    }
  }
  return found;
}

function streamText(raw: string): string {
  let acc = '';
  let locked = false;
  for (const line of raw.split(/\r?\n/)) {
    const piece = readStreamLine(line);
    if (!piece || piece.guessKind === 'user') {
      continue;
    }
    const next = takeAnswer(acc, locked, piece);
    acc = next.text;
    locked = next.locked;
  }
  return acc;
}
