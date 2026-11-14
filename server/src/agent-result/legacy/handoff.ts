// remove after runs started before f52 are gone
export interface HandoffEntry {
  step: string;
  body: string;
}

/** A handoff stored as `## <step>` blocks. Only a line that starts with `## ` opens a block. */
export function legacyHandoff(text: string): HandoffEntry[] {
  return text
    .split(/^## /m)
    .filter((part) => part.trim())
    .map((part) => {
      const newline = part.indexOf('\n');
      return {
        step: (newline === -1 ? part : part.slice(0, newline)).trim(),
        body: newline === -1 ? '' : part.slice(newline + 1).trim(),
      };
    });
}
