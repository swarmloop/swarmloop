import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { usePhone } from '../../lib/use-phone';

type SectionState = 'loading' | 'failed' | 'ready';

interface Source {
  loaded: boolean;
  failed: boolean;
}

/** What a part shows while its data comes: a failed request wins over a pending one, and data that arrived stays. */
export function sectionState(...sources: Source[]): SectionState {
  if (sources.some((source) => source.failed && !source.loaded)) {
    return 'failed';
  }
  return sources.every((source) => source.loaded) ? 'ready' : 'loading';
}

/** The grid of the cards: one column below 900 px, as many 160 px columns as fit from it. */
export function useCardGridSx(): { display: 'grid'; gap: number; gridTemplateColumns: string } {
  const phone = usePhone();
  return {
    display: 'grid',
    gap: 1,
    gridTemplateColumns: phone ? 'minmax(0, 1fr)' : 'repeat(auto-fit, minmax(160px, 1fr))',
  };
}

/** Grey shapes in the place of the cards or lines that come. */
export function Placeholders({
  count,
  height,
  testId,
  grid,
}: {
  count: number;
  height: number;
  testId: string;
  grid: boolean;
}): ReactElement {
  const cardGridSx = useCardGridSx();
  return (
    <Box sx={grid ? cardGridSx : { display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} variant="rounded" height={height} data-testid={testId} />
      ))}
    </Box>
  );
}

/** The line of a part whose data could not be read. */
export function LoadFailed({ what }: { what: string }): ReactElement {
  return (
    <Typography color="text.secondary" role="alert">
      {`Could not load ${what}.`}
    </Typography>
  );
}
