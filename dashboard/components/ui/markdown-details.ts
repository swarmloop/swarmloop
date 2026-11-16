type MarkdownPart = { kind: 'markdown'; text: string } | { kind: 'details'; summary: string; text: string };

const MARKER_LINE = /^[ \t]*<!--\s*\/?swarmloop:[^>]*-->[ \t]*\r?\n?/gm;
const DETAILS_BLOCK = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g;

/** Drops the hidden swarmloop marker lines and splits the rest into plain markdown and folded blocks. */
export function splitMarkdownDetails(text: string): MarkdownPart[] {
  const clean = text.replace(MARKER_LINE, '');
  const parts: MarkdownPart[] = [];
  let last = 0;
  for (const match of clean.matchAll(DETAILS_BLOCK)) {
    pushMarkdown(parts, clean.slice(last, match.index));
    parts.push({ kind: 'details', summary: match[1].trim(), text: match[2].trim() });
    last = match.index + match[0].length;
  }
  pushMarkdown(parts, clean.slice(last));
  return parts;
}

function pushMarkdown(parts: MarkdownPart[], text: string): void {
  if (text.trim()) {
    parts.push({ kind: 'markdown', text });
  }
}
