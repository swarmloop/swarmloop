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
  if (host === 'api.github.com' || host.endsWith('.github.com')) {
    const pull = /\/pulls(?:\/(\d+))?$/.exec(path);
    if (pull) {
      const verb = method === 'POST' ? 'create' : method === 'GET' ? 'read' : 'update';
      return `GitHub: ${verb} pull request${pull[1] ? ` #${pull[1]}` : ''}`;
    }
    const run = /\/actions\/runs\/(\d+)/.exec(path);
    if (run) {
      return `GitHub: workflow run ${run[1]} status`;
    }
  }
  const pipeline = /\/pipelines\/(\d+)/.exec(path);
  if (pipeline) {
    return `GitLab: pipeline ${pipeline[1]} status`;
  }
  const job = /\/jobs\/(\d+)\/trace/.exec(path);
  if (job) {
    return `GitLab: job ${job[1]} log`;
  }
  const merge = /\/merge_requests(?:\/(\d+))?$/.exec(path);
  if (merge) {
    const verb = method === 'POST' ? 'create' : method === 'GET' ? 'read' : 'update';
    return `GitLab: ${verb} merge request${merge[1] ? ` !${merge[1]}` : ''}`;
  }
  return `${method} ${host}`;
}
