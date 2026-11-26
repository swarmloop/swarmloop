'use client';

import type { ReactElement } from 'react';
import Skeleton from '@mui/material/Skeleton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import type { Part, PartCounts } from '@contract/run-list';

const LABELS: { part: Part; label: string }[] = [
  { part: 'active', label: 'Active' },
  { part: 'done', label: 'Done' },
  { part: 'all', label: 'All' },
];

export function ShowControl({
  part,
  counts,
  onPart,
}: {
  part: Part;
  counts: PartCounts | null;
  onPart: (part: Part) => void;
}): ReactElement {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      fullWidth
      value={part}
      aria-label="Show runs"
      onChange={(_event, value: Part | null) => {
        if (value) {
          onPart(value);
        }
      }}
    >
      {LABELS.map(({ part: value, label }) => (
        <ToggleButton key={value} value={value} sx={{ textTransform: 'none', fontVariantNumeric: 'tabular-nums' }}>
          {counts ? (
            `${label} ${counts[value]}`
          ) : (
            <>
              {`${label} `}
              <Skeleton variant="text" width="1.5ch" sx={{ display: 'inline-block' }} data-testid="count-placeholder" />
            </>
          )}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
