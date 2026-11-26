'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { usePhone } from '../../../lib/use-phone';
import { phaseLabel } from '../../../lib/phase-label';

import type { CheckCommandView, FlowView } from '@contract/api';
import type { StateReason } from '@contract/run-state';
import { withReport } from '../phases';
import { StepCard } from './step-card';

export function FlowBoard({
  phases,
  returns,
  selected,
  onSelect,
  checkCommands = [],
  stateReason = null,
}: {
  phases: FlowView['phases'];
  returns: FlowView['returns'];
  selected: string | null;
  onSelect: (name: string) => void;
  /** The commands of the latest checks attempt: the checks card shows how far they are. */
  checkCommands?: CheckCommandView[];
  /** Why the run waits: it says what a waiting current step waits for. */
  stateReason?: StateReason | null;
}): ReactElement {
  const phone = usePhone();
  const columns = Math.max(phases.length, 1);
  return (
    <Box sx={{ mt: 4 }}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: phone ? 'minmax(0, 1fr)' : `repeat(${columns}, minmax(0, 1fr))`,
          gap: 1.5,
        }}
      >
        {phases.map((phase) => (
          <Box key={phase.phase} sx={{ minWidth: 0 }}>
            <Typography
              variant="overline"
              color="text.secondary"
              sx={{ display: 'block', letterSpacing: '0.06em', lineHeight: 1.3, mb: 1.25, whiteSpace: 'nowrap' }}
            >
              {phaseLabel(phase.phase)}
            </Typography>
            <Box
              sx={phone ? { display: 'flex', gap: 0.75, overflowX: 'auto', pb: 0.5 } : { display: 'grid', gap: 0.75 }}
            >
              {withReport(phase.steps).map((step) => {
                return (
                  <StepCard
                    key={step.name}
                    step={step}
                    active={step.name === selected}
                    phone={phone}
                    returns={returns}
                    stateReason={stateReason}
                    checkCommands={checkCommands}
                    onSelect={onSelect}
                  />
                );
              })}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
