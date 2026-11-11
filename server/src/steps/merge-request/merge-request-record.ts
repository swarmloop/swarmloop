import { SwarmloopError } from '../../core/swarmloop-error';
export { remoteProject } from '../../integrations/code-host/remote-project';

export interface MergeRequestLine {
  project: string;
  iid: number;
  url: string;
  draft: boolean;
}

/** A record without a `draft:` line is from before drafts and reads as ready. */
export function parseMergeRequests(body: string): MergeRequestLine[] {
  const records: MergeRequestLine[] = [];
  let project = '';
  let iid = 0;
  let url = '';
  let draft = false;
  const flush = (): void => {
    if (project && iid > 0 && url) {
      records.push({ project, iid, url, draft });
    }
    project = '';
    iid = 0;
    url = '';
    draft = false;
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
    } else if (line.startsWith('draft: ')) {
      draft = line.slice('draft: '.length).trim() === 'true';
    }
  }
  flush();
  if (records.length === 0) {
    throw new SwarmloopError('merge_request is missing');
  }
  return records;
}

export function renderMergeRequest(records: (MergeRequestLine & { summary: string })[]): string {
  const blocks = records.map((record) => {
    const head = `project: ${record.project}\niid: ${record.iid}\nurl: ${record.url}\ndraft: ${record.draft}`;
    const prose = record.summary.trim();
    return prose ? `${head}\n\n${prose}` : head;
  });
  return `${blocks.join('\n\n')}\n`;
}

/** The link of each merge request with its state, as the step window shows it. */
export function mergeRequestDetails(records: { url: string; draft: boolean }[]): string[] {
  return records.map((record) => `${record.url} (${record.draft ? 'draft' : 'ready'})`);
}
