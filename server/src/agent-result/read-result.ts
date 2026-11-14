import { parseResultBlock } from '../contract/result-block';
import { readStreamLine, takeAnswer } from '../agent/stream';
import type { ResultDefinition } from './result-definition';

type ResultRead = { ok: true; value: unknown } | { ok: false; errors: string[] };

/** Reads the result block of a final message and checks it against the schema. Every error is returned. */
export function readResult(definition: ResultDefinition, finalMessage: string): ResultRead {
  const parsed = parseResultBlock(finalMessage);
  if (!parsed.ok) {
    return { ok: false, errors: [parsed.error] };
  }
  const checked = definition.schema.validate(parsed.value, { abortEarly: false, allowUnknown: false });
  const { error } = checked;
  if (error) {
    return {
      ok: false,
      errors: error.details.map((detail) => `${detail.path.join('.') || 'result'}: ${detail.message}`),
    };
  }
  return { ok: true, value: checked.value as unknown };
}

/** The final answer text of a stored stream: the finished assistant message, as the live reader takes it. */
function answerOfStream(output: string): string {
  let text = '';
  let locked = false;
  for (const line of output.split('\n')) {
    const piece = readStreamLine(line);
    if (piece && (piece.text || piece.finalMessage)) {
      ({ text, locked } = takeAnswer(text, locked, piece));
    }
  }
  return text;
}

/** Reads the result block of the answer held in a stored stream. */
export function readResultFromOutput(definition: ResultDefinition, output: string): ResultRead {
  return readResult(definition, answerOfStream(output));
}
