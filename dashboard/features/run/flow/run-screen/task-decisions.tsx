import { useState, type ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { MarkdownBody } from '../../../../components/ui/markdown-body';

const CLAMP_LINES = 6;

/** The planner's decisions as markdown, clamped to six lines when longer. */
export function TaskDecisions({ text }: { text: string }): ReactElement {
  const [all, setAll] = useState(false);
  const long = text.split('\n').length > CLAMP_LINES;
  return (
    <Box component="section" aria-label="Decisions">
      <Typography variant="subtitle2">Decisions</Typography>
      <Box sx={long && !all ? { maxHeight: `${CLAMP_LINES * 1.6}em`, overflow: 'hidden' } : undefined}>
        <MarkdownBody text={text} />
      </Box>
      {long ? (
        <Button size="small" onClick={() => setAll(!all)}>
          {all ? 'Show less' : 'Show all'}
        </Button>
      ) : null}
    </Box>
  );
}
