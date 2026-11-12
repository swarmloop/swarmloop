import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import { MarkdownBody } from '../../../../components/ui/markdown-body';

/** The files, one path per line, and the proof of a task, rendered as markdown. */
export function TaskDetails({ files, proof }: { files: string[]; proof: string }): ReactElement {
  return (
    <Box sx={{ pl: 4, pb: 1, minWidth: 0 }}>
      {files.length > 0 ? (
        <Box component="ul" sx={{ m: 0, pl: 2, fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-all' }}>
          {files.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </Box>
      ) : null}
      {proof ? <MarkdownBody text={proof} /> : null}
    </Box>
  );
}
