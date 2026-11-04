export function withAddedRepos(prompt: string, note: string | null): string {
  if (!note?.trim()) {
    return prompt;
  }
  return `${prompt.trimEnd()}\n\n${note.trim()}\n`;
}

export function isPipelineReturn(notes: string | null | undefined): boolean {
  if (!notes) {
    return false;
  }
  const lines = notes.split(/\r?\n/).map((line) => line.trim());
  return lines.includes('## pipeline') && lines.includes('result: fail');
}

/** The returned text starts with this line when `verify` sent the run back. */
export const VERIFY_RETURN_PREFIX = 'verify failed (it ran in ';

export function isVerifyReturn(notes: string | null | undefined): boolean {
  return notes?.startsWith(VERIFY_RETURN_PREFIX) ?? false;
}

/** The documents as code review sees them: a verify return is not a reviewer's return. */
export function withoutVerifyReturns<T extends { kind: string; body: string }>(documents: T[]): T[] {
  return documents.filter((item) => !(item.kind === 'return' && isVerifyReturn(item.body)));
}
