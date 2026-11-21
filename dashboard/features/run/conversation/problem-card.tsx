import type { ReactElement, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { isLong } from './conversation-words';

/**
 * A problem in plain words: the sentence, the reason (folded when long; `preformatted` keeps its line breaks), what
 * the caller adds as children, and Resume when it has a label.
 */
export function ProblemCard({
  sentence,
  reason,
  preformatted = false,
  resume,
  children,
}: {
  sentence: string;
  reason: string | null;
  preformatted?: boolean;
  resume?: { label: string; disabled: boolean; onClick: () => void };
  children?: ReactNode;
}): ReactElement {
  return (
    <Paper
      component="section"
      aria-label="Problem"
      variant="outlined"
      sx={{ p: 1.5, borderColor: 'error.main', overflowWrap: 'anywhere' }}
    >
      <Typography variant="body2">{sentence}</Typography>
      {reason ? (
        isLong(reason) ? (
          <Box component="details" sx={{ mt: 1 }}>
            <Box component="summary" sx={{ cursor: 'pointer', fontSize: 14 }}>
              Show the whole report
            </Box>
            <MarkdownBody text={reason} />
          </Box>
        ) : preformatted ? (
          <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {reason}
          </Typography>
        ) : (
          <MarkdownBody text={reason} />
        )
      ) : null}
      {children}
      {resume ? (
        <Button variant="contained" size="small" disabled={resume.disabled} onClick={resume.onClick} sx={{ mt: 1 }}>
          {resume.label}
        </Button>
      ) : null}
    </Paper>
  );
}
