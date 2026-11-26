'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { restartWaitSentence } from '@contract/restart-wait';
import { localTime } from '../../../lib/format';
import { phaseLabel } from '../../../lib/phase-label';
import { stepLabel, withReport } from '../phases';
import { SLOT_WAIT, waitsForSlot } from '../check-commands';
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
                      {step.attempts > 1 ? (
                        <Box component="span" sx={{ ml: 'auto', fontSize: 10, color: 'text.secondary' }}>
                          {`×${step.attempts}`}
                        </Box>
                      ) : null}
                      {step.name === 'checks' ? <ChecksCard step={step} commands={checkCommands} /> : null}
                    </Box>
                  </Tooltip>
                );
              })}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

type Step = FlowView['phases'][number]['steps'][number];

/** What the checks card adds: the wait for a free check slot while no command runs, and how far the commands are. */
function ChecksCard({ step, commands }: { step: Step; commands: CheckCommandView[] }): ReactElement {
  return (
    <>
      {step.status === 'running' && waitsForSlot(commands) ? (
        <Box component="span" sx={{ fontSize: 10, color: 'text.secondary' }}>
          {SLOT_WAIT}
        </Box>
      ) : null}
      {commands.length > 0 ? <ChecksProgress commands={commands} /> : null}
    </>
  );
}

/** The words of the return a step sent: the code review's reviewers all send theirs from `code-review`. */
function returnWords(returns: FlowView['returns'], step: string): string {
  const from = step.startsWith('code-review') ? 'code-review' : step;
  return returns.find((edge) => edge.from === from)?.words ?? 'Sent work back';
}

/** What the hover on a card says: why a step went back, or what the run waits for. */
function cardTip(step: Step, returns: FlowView['returns'], stateReason: StateReason | null): string {
  if (step.status === 'returned') return step.returnNote ?? returnWords(returns, step.name);
  if (step.status === 'waiting' && step.current) return stateWord('waiting', stateReason, {}, localTime).word;
  return '';
}
