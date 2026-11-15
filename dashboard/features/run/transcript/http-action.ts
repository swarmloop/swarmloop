import { HOST_TEXTS } from '../../connections/logos';

/** The provider action behind an HTTP call, from a small map for each integration. The URL stays in the details. */
export function httpAction(method: string, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${method} call`;
  }
  const path = parsed.pathname;
  const host = parsed.hostname;
  const jira = /\/rest\/api\/\d+\/issue\/([A-Z][A-Z0-9]*-\d+)(\/comment)?$/.exec(path);
  if (jira) {
    return jira[2]
      ? `Jira: ${method === 'GET' ? 'read comments of' : 'comment on'} ${jira[1]}`
      : `Jira: ${method === 'GET' ? 'read' : 'update'} ${jira[1]}`;
  }
  if (/\/rest\/api\/\d+\/search/.test(path)) {
    return 'Jira: search tickets';
  }
  for (const entry of HOST_TEXTS) {
    const label = entry.servesHost(host) ? entry.action(method, path) : undefined;
    if (label) {
      return label;
    }
  }
  return `${method} ${host}`;
}
