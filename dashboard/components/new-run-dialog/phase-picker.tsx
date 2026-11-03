'use client';

import type { Dispatch, ReactElement, SetStateAction } from 'react';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import { PHASE_LABEL } from '../../lib/phases';
import type { PhaseName } from '@contract/steps';
import { PHASES } from '@contract/steps';

export function PhasePicker({
  picked,
  frozen,
  setPicked,
}: {
  picked: PhaseName[];
  frozen: PhaseName[];
  setPicked: Dispatch<SetStateAction<PhaseName[]>>;
}): ReactElement {
  return (
    <FormGroup sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, max-content)', columnGap: 2, rowGap: 0.5 }}>
      {PHASES.map((phase) => (
        <FormControlLabel
          key={phase}
          sx={{ mr: 0 }}
          label={PHASE_LABEL[phase]}
          control={
            <Checkbox
              size="small"
              checked={phase === 'requirements' || picked.includes(phase)}
              disabled={frozen.includes(phase)}
              onChange={(event) => {
                setPicked((current) =>
                  event.target.checked
                    ? PHASES.filter((item) => item === phase || current.includes(item))
                    : current.filter((item) => item !== phase),
                );
              }}
            />
          }
        />
      ))}
    </FormGroup>
  );
}
