const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]+-\d+$/;

/** Issue key from a Jira browse, board, or issue URL. The host is not checked. */
export function jiraIssueKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const selected = parsed.searchParams.get('selectedIssue')?.trim() ?? '';
  if (ISSUE_KEY.test(selected)) {
    return selected.toUpperCase();
  }
  const match = parsed.pathname.match(/\/(?:browse|issues)\/([A-Za-z][A-Za-z0-9]+-\d+)\/?$/);
  return match?.[1] ? match[1].toUpperCase() : null;
}

/** Issue key when the URL points at the same Jira site as `base`. */
export function sameSiteIssueKey(url: string, base: string): string | null {
  try {
    if (new URL(url).host !== new URL(base).host) {
      return null;
    }
  } catch {
    return null;
  }
  return jiraIssueKey(url);
}
