import { SwarmloopError } from '../../core/swarmloop-error';
export { remoteProject } from '../../integrations/code-host/remote-project';

export interface MergeRequestLine {
  project: string;
  iid: number;
  url: string;
  draft: boolean;
}

interface MergeRequestBlock extends MergeRequestLine {
  prose: string[];
}

/** A record without a `draft:` line is from before drafts and reads as ready. */
function readBlocks(body: string): MergeRequestBlock[] {
  const records: MergeRequestBlock[] = [];
  let project = '';
  let iid = 0;
  let url = '';
  let draft = false;
  let prose: string[] = [];
  const flush = (): void => {
    if (project && iid > 0 && url) {
      records.push({ project, iid, url, draft, prose });
    }
    project = '';
    iid = 0;
    url = '';
    draft = false;
    prose = [];
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
    } else {
      prose.push(line);
    }
  }
  flush();
  if (records.length === 0) {
    throw new SwarmloopError('merge_request is missing');
  }
  return records;
}

export function parseMergeRequests(body: string): MergeRequestLine[] {
  return readBlocks(body).map(({ project, iid, url, draft }) => ({ project, iid, url, draft }));
}

/** The prose of each record, in record order, without the `flaky:` lines a pipeline pass appended. */
export function parseMergeRequestSummaries(body: string): string[] {
  return readBlocks(body).map((record) =>
    record.prose
      .filter((line) => !line.startsWith('flaky: '))
      .join('\n')
      .trim(),
  );
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
