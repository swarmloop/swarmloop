/** How the default branch of a repository stands now: its head commit and the state of the CI on it. */
export interface RepositoryMainView {
  repository: string;
  branch: string;
  /** 'none' is no CI to wait for: the code host reports no CI for the project, or its CI never ran on this branch. */
  state: 'green' | 'pending' | 'red' | 'none';
  head: string | null;
  failingJobs: string[];
  /** How long the last pipeline took; null when it has no checks. */
  durationMs: number | null;
  url: string | null;
}
