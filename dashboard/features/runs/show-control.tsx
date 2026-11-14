'use client';

import type { ReactElement } from 'react';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import type { Part, PartCounts } from './run-filter';

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
  counts: PartCounts;
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
          {`${label} ${counts[value]}`}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
