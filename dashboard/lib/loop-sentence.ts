interface LoopNote {
  command: string;
  errorLine: string;
  count: number;
  ended?: true;
}

/** `npm test ×8: the step ended. Error: ...`, or the hint the agent got after the first repeats. */
export function loopSentence(note: LoopNote): string {
  const error = note.errorLine ? ` Error: ${note.errorLine}` : '';
  return note.ended
    ? `${note.command} ×${note.count}: the step ended because the agent kept repeating it.${error}`
    : `${note.command} failed ${note.count} times in a row. The agent got a hint to try another approach.${error}`;
}
