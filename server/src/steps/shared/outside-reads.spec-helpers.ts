const PATH = /(?:<work>|\/work)\/[^\s`'")\]]*/g;
const DIRECTORY_LINES = [/^The only working directory is (\S+) \(/, /^- .+ at (\S+?)\. /];
const ALSO_READ = 'Also read, and nothing else outside: ';

function trimmed(path: string): string {
  return path.replace(/[.,;:]+$/, '');
}

function opening(prompt: string): string[] {
  return prompt.split('\n\n')[0].split('\n');
}

/** The working directories and the "Also read" paths that the opening lines of a prompt allow. */
function allowed(prompt: string): { directories: string[]; reads: string[] } {
  const lines = opening(prompt);
  const directories = lines.flatMap((line) => {
    const found = DIRECTORY_LINES.map((pattern) => pattern.exec(line)?.[1]).find(Boolean);
    return found ? [trimmed(found)] : [];
  });
  const read = lines.find((line) => line.startsWith(ALSO_READ)) ?? '';
  const reads = [...read.slice(ALSO_READ.length).matchAll(/(\S+) \([^)]*\)/g)].map((match) => trimmed(match[1]));
  return { directories, reads };
}

/**
 * Every absolute path under /work (or `<work>`) that the prompt names and its block does not allow. A prompt without a
 * block is judged by the block of `earlier`, the first prompt of the same chat.
 */
export function unallowedReads(prompt: string, earlier?: string): string[] {
  const own = allowed(prompt);
  const before =
    own.directories.length === 0 && earlier !== undefined ? allowed(earlier) : { directories: [], reads: [] };
  const roots = [...own.directories, ...own.reads, ...before.directories, ...before.reads];
  const under = (path: string, root: string): boolean => path === root || path.startsWith(root.replace(/\/?$/, '/'));
  return (prompt.match(PATH) ?? []).map(trimmed).filter((path) => !roots.some((root) => under(path, root)));
}
