'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { restartWaitSentence } from '@contract/restart-wait';
import { localTime } from '../../../lib/format';
import { phaseLabel } from '../../../lib/phase-label';
import { stepLabel, withReport } from '../phases';
import type { CheckCommandView, FlowView } from '@contract/api';
import { ChecksProgress } from './checks-progress';
import { stateWord, type StateReason } from '@contract/run-state';
import { stepState } from '@contract/step-state';
import { StepStateIcon } from '../step-state-icon';
import { toneColor } from '../run-state-word';

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
  const columns = Math.max(phases.length, 1);
  return (
    <Box sx={{ mt: 4 }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 1.5 }}>
        {phases.map((phase) => (
          <Box key={phase.phase} sx={{ minWidth: 0 }}>
            <Typography
              variant="overline"
              color="text.secondary"
              sx={{ display: 'block', letterSpacing: '0.06em', lineHeight: 1.3, mb: 1.25, whiteSpace: 'nowrap' }}
            >
              {phaseLabel(phase.phase)}
            </Typography>
            <Box sx={{ display: 'grid', gap: 0.75 }}>
              {withReport(phase.steps).map((step) => {
                const active = step.name === selected;
                const state = stepState(step.status, step.current ? stateReason : null);
                const tone = toneColor(state.tone);
                const isError = state.tone === 'error';
                const marker = step.name === 'done';
                return (
                  <Tooltip key={step.name} describeChild title={cardTip(step, returns, stateReason)}>
                    <Box
                      component={marker ? 'div' : 'button'}
                      type={marker ? undefined : 'button'}
                      onClick={marker ? undefined : () => onSelect(step.name)}
                      aria-current={step.current ? 'step' : undefined}
                      sx={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: 1,
                        width: '100%',
                        textAlign: 'left',
                        cursor: marker ? 'default' : 'pointer',
                        font: 'inherit',
                        color: step.status === 'idle' ? 'text.secondary' : 'text.primary',
                        bgcolor: active ? 'background.default' : 'background.paper',
                        border: '1px solid',
                        borderColor: isError ? tone : step.current ? 'primary.main' : 'divider',
                        borderRadius: 1.5,
                        transition: 'border-color 0.2s ease, box-shadow 0.2s ease, background-color 0.2s ease',
                        boxShadow: (theme) =>
                          step.current
                            ? `0 0 0 3px rgba(${isError ? theme.vars?.palette.error.mainChannel : theme.vars?.palette.primary.mainChannel} / 0.14)`
                            : 'none',
                        px: 1.25,
                        py: 1,
                      }}
                    >
                      <Box
                        component="span"
                        sx={{
                          display: 'inline-flex',
                          animation:
                            step.status === 'running' || step.status === 'preparing'
                              ? 'swarmloop-pulse 1.6s ease-in-out infinite'
                              : 'none',
                        }}
                      >
                        <StepStateIcon state={state} />
                      </Box>
                      <Box component="span" sx={{ fontSize: 11, lineHeight: 1.3, overflowWrap: 'anywhere' }}>
                        {stepLabel(step.name)}
                      </Box>
                      {step.status === 'preparing' ? (
                        <Box component="span" sx={{ fontSize: 10, color: 'info.main' }}>
                          preparing
                        </Box>
                      ) : null}
                      {step.note || step.restartedAt ? (
                        <Box component="span" sx={{ fontSize: 10, color: 'text.secondary' }}>
                          {step.note ??
                            (step.restartedAt ? restartWaitSentence(step.restartedAt, localTime) : undefined)}
                        </Box>
                      ) : null}
                      {step.attempts > 0 ? (
                        <Tooltip describeChild title={`ran ${step.attempts === 1 ? 'once' : `${step.attempts} times`}`}>
                          <Box
                            component="span"
                            sx={{
                              ml: 'auto',
                              minWidth: 18,
                              height: 18,
                              px: 0.5,
                              borderRadius: 9,
                              bgcolor: tone,
                              color: 'primary.contrastText',
                              fontSize: 11,
                              lineHeight: '18px',
                              textAlign: 'center',
                            }}
                          >
                            {step.attempts}
                          </Box>
                        </Tooltip>
                      ) : null}
                      {step.name === 'checks' && checkCommands.length > 0 ? (
                        <ChecksProgress commands={checkCommands} />
                      ) : null}
                    </Box>
                  </Tooltip>
                );
              })}
            </Box>
          </Box>
        ))}
      </Box>
      {returns.length > 0 ? (
        <Box sx={{ position: 'relative', mt: 1, height: returns.length * 36 }}>
          {returns.map((edge, index) => {
            const target = phaseIndex(phases, 'implement');
            const from = Math.max(phaseIndex(phases, edge.from), target);
            const span = from - target + 1;
            return (
              <Box
                key={`${edge.counter}:${index}`}
                sx={{
                  position: 'absolute',
                  top: index * 36,
                  left: `${(target / columns) * 100}%`,
                  width: `${(span / columns) * 100}%`,
                  height: 12,
                  borderLeft: '1px solid',
                  borderBottom: '1px solid',
                  borderColor: 'error.main',
                  borderBottomLeftRadius: 8,
                }}
              >
                <Typography
                  component="span"
                  variant="body2"
                  sx={{ position: 'absolute', right: 0, top: 14, color: 'error.main' }}
                >
                  {returnLabel(edge)}
                </Typography>
              </Box>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
}

/** Where the work of a returned step went: the target of its return edge. */
function returnTarget(returns: FlowView['returns'], step: string): string {
  const from = step.startsWith('code-review') ? 'code-review' : step;
  return returns.find((edge) => edge.from === from)?.to ?? 'implement';
}

function returnLabel(edge: FlowView['returns'][number]): string {
  const base = `${edge.from} → ${edge.to} · ${edge.count === 1 ? 'once' : `${edge.count} times`}`;
  return edge.why ? `${base} (${edge.why})` : base;
}

type Step = FlowView['phases'][number]['steps'][number];

/** What the hover on a card says: why a step went back, or what the run waits for. */
function cardTip(step: Step, returns: FlowView['returns'], stateReason: StateReason | null): string {
  if (step.status === 'returned')
    return `returned: ${step.returnNote ?? `returned to ${returnTarget(returns, step.name)}`}`;
  if (step.status === 'waiting' && step.current) return stateWord('waiting', stateReason, {}, localTime).word;
  return '';
}

function phaseIndex(phases: FlowView['phases'], step: string): number {
  const index = phases.findIndex((phase) =>
    phase.steps.some((item) => item.name === step || (step === 'code-review' && item.name.startsWith('code-review-'))),
  );
  return Math.max(index, 0);
}
