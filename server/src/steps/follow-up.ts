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
