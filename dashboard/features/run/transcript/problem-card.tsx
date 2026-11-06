import type { ReactElement, ReactNode } from 'react';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { Problem } from './transcript-model';

/** The element id a link to the problem uses. */
export const problemId = (eventId: string): string => `problem-${eventId}`;

/** A failed action in place: the label says "Error" in words, so the red border is never the only signal. */
export function ProblemCard({
  eventId,
  problem,
  children,
}: {
  eventId: string;
  problem: Problem;
  children: ReactNode;
}): ReactElement {
  return (
    <Box
      id={problemId(eventId)}
      role="group"
      aria-label={`Error: ${problem.cause}`}
      sx={{
        minWidth: 0,
        border: 2,
        borderColor: 'error.main',
        borderRadius: 1,
        p: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'error.main', flexWrap: 'wrap' }}>
        <ErrorOutline fontSize="small" aria-hidden />
        <Typography component="span" sx={{ fontWeight: 600 }}>
          Error
        </Typography>
        <Typography component="span" sx={{ overflowWrap: 'anywhere' }}>
          {problem.cause}
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {problem.action} · id {eventId}
      </Typography>
      {children}
    </Box>
  );
}
