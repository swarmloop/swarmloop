'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { stepLabel, withReport } from '../../lib/phases';
import { FlowView } from '../../lib/types';
import { statusColor } from '../../theme/theme';

export function FlowBoard({
  phases,
  returns,
  selected,
  onSelect,
}: {
  phases: FlowView['phases'];
  returns: FlowView['returns'];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const columns = Math.max(phases.length, 1);
  return (
    <Box sx={{ mt: 4 }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 1.5 }}>
        {phases.map((phase) => (
          <Box key={phase.phase} sx={{ minWidth: 0 }}>
            <Typography variant="overline" color="text.secondary" sx={{ display: 'block', letterSpacing: '0.06em', lineHeight: 1.3, mb: 1.25, whiteSpace: 'nowrap' }}>
              {phase.phase}
            </Typography>
            <Box sx={{ display: 'grid', gap: 0.75 }}>
              {withReport(phase.steps).map((step) => {
                const active = step.name === selected;
                return (
                  <Box
                    key={step.name}
                    component="button"
                    type="button"
                    onClick={() => onSelect(step.name)}
                    aria-current={step.current ? 'step' : undefined}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      width: '100%',
                      textAlign: 'left',
                      cursor: 'pointer',
                      font: 'inherit',
                      color: step.status === 'idle' ? 'text.secondary' : 'text.primary',
                      bgcolor: active ? 'background.default' : 'background.paper',
                      border: '1px solid',
                      borderColor: failedStep(step.status) ? statusColor(step.status) : step.current ? 'primary.main' : 'divider',
                      borderRadius: 1.5,
                      transition: 'border-color 0.2s ease, box-shadow 0.2s ease, background-color 0.2s ease',
                      boxShadow: (theme) =>
                        step.current
                          ? `0 0 0 3px rgba(${failedStep(step.status) ? theme.vars?.palette.error.mainChannel : theme.vars?.palette.primary.mainChannel} / 0.14)`
                          : 'none',
                      px: 1.25,
                      py: 1,
                    }}
                  >
                    <Box
                      component="span"
                      sx={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        bgcolor: statusColor(step.status),
                        flexShrink: 0,
                        animation: step.status === 'running' ? 'swarmloop-pulse 1.6s ease-in-out infinite' : 'none',
                      }}
                    />
                    <Box component="span" sx={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.3, overflowWrap: 'anywhere' }}>
                      {stepLabel(step.name)}
                    </Box>
                    {step.attempts > 0 ? (
                      <Box
                        component="span"
                        sx={{
                          ml: 'auto',
                          minWidth: 18,
                          height: 18,
                          px: 0.5,
                          borderRadius: 9,
                          bgcolor: statusColor(step.status),
                          color: 'primary.contrastText',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          lineHeight: '18px',
                          textAlign: 'center',
                        }}
                      >
                        {step.attempts}
                      </Box>
                    ) : null}
                  </Box>
                );
              })}
            </Box>
          </Box>
        ))}
      </Box>
      {returns.length > 0 ? (
        <Box sx={{ position: 'relative', mt: 1, height: returns.length * 36 }}>
          {returns.map((edge, index) => {
            const from = Math.max(phaseIndex(phases, edge.from), 2);
            const span = from - 2 + 1;
            return (
              <Box
                key={edge.counter}
                sx={{
                  position: 'absolute',
                  top: index * 36,
                  left: `${(2 / columns) * 100}%`,
                  width: `${(span / columns) * 100}%`,
                  height: 12,
                  borderLeft: '1px solid',
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  borderBottomLeftRadius: 8,
                }}
              >
                <Typography
                  component="span"
                  sx={{ position: 'absolute', right: 0, top: 14, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'text.secondary' }}
                >
                  {edge.from} → implement · {edge.counter} × {edge.count}
                </Typography>
              </Box>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
}

function failedStep(status: string): boolean {
  return status === 'failed' || status === 'blocked';
}

function phaseIndex(phases: FlowView['phases'], step: string): number {
  const index = phases.findIndex((phase) =>
    phase.steps.some((item) => item.name === step || (step === 'code-review' && item.name.startsWith('code-review-'))),
  );
  return index < 0 ? 2 : index;
}
