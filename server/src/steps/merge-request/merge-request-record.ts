import { SwarmloopError } from '../../core/swarmloop-error';
export { remoteProject, type RemoteProject } from '../../integrations/code-host/remote-project';

export function parseMergeRequests(body: string): { project: string; iid: number; url: string }[] {
  const records: { project: string; iid: number; url: string }[] = [];
  let project = '';
  let iid = 0;
  let url = '';
  const flush = (): void => {
    if (project && iid > 0 && url) {
      records.push({ project, iid, url });
    }
    project = '';
    iid = 0;
    url = '';
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('project: ')) {
      if (project) {
        flush();
      }
      project = line.slice('project: '.length).trim();
    } else if (line.startsWith('iid: ')) {
      iid = Number(line.slice('iid: '.length).trim());
    } else if (line.startsWith('url: ')) {
      url = line.slice('url: '.length).trim();
    }
  }
  flush();
  if (records.length === 0) {
    throw new SwarmloopError('merge_request is missing');
  }
  return records;
}

export function renderMergeRequest(records: { project: string; iid: number; url: string; summary: string }[]): string {
  const blocks = records.map((record) => {
    const head = `project: ${record.project}\niid: ${record.iid}\nurl: ${record.url}`;
    const prose = record.summary.trim();
    return prose ? `${head}\n\n${prose}` : head;
  });
  return `${blocks.join('\n\n')}\n`;
}
