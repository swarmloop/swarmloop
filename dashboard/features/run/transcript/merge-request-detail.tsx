import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import { MarkdownBody } from '../../../components/ui/markdown-body';

/** One merge request of the `merge_request` document: its link, its state and the summary under it. A missing `draft:` line is ready. */
function requestOf(block: string): { url: string; draft: boolean; summary: string } {
  const [head = '', ...prose] = block.split(/\n\s*\n/);
  const line = (name: string): string =>
    head
      .split('\n')
      .find((item) => item.startsWith(`${name}: `))
      ?.slice(name.length + 2)
      .trim() ?? '';
  return { url: line('url'), draft: line('draft') === 'true', summary: prose.join('\n\n').trim() };
}

/** The merge requests of a run with the draft or ready state next to each link. */
export function MergeRequestDetail({ body }: { body: string }): ReactElement {
  const requests = body
    .split(/\n\s*\n(?=project: )/)
    .map(requestOf)
    .filter((request) => request.url);
  if (requests.length === 0) {
    return <MarkdownBody text={body} />;
  }
  return (
    <Box sx={{ minWidth: 0 }}>
      {requests.map((request) => (
        <Box key={request.url} sx={{ mt: 1 }}>
          <Link href={request.url}>{request.url}</Link> {request.draft ? 'Draft' : 'Ready'}
          {request.summary ? <MarkdownBody text={request.summary} /> : null}
        </Box>
      ))}
    </Box>
  );
}
