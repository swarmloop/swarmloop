/** What the core knows of a host without an instance: its name, CI files and how it words a refused push. */
export interface CodeHostRules {
  readonly name: string;
  readonly label: string;
  /** CI config paths. A last segment of `*<ending>` matches any file of that folder with the ending. */
  readonly ciFiles: readonly string[];
  /** The line of a git error that explains a refused push. */
  pushRejection(lines: string[]): string | undefined;
  /** The provider label for a call of this host's API, or null for any other url. */
  classifyCall(url: string): string | null;
}

/** The generic rule: the first line where the remote rejected the push. */
export function remotePushRejection(lines: string[]): string | undefined {
  return lines.find((line) => line.includes('remote rejected'));
}
