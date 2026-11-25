'use client';

import type { ComponentType, ReactElement } from 'react';
import type { SvgIconProps } from '@mui/material/SvgIcon';
import CheckCircle from '@mui/icons-material/CheckCircle';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import PauseCircleOutline from '@mui/icons-material/PauseCircleOutline';
import RadioButtonUnchecked from '@mui/icons-material/RadioButtonUnchecked';
import SkipNext from '@mui/icons-material/SkipNext';
import Undo from '@mui/icons-material/Undo';
import type { StepState, StepIcon } from '@contract/step-state';
import { toneColor } from './run-state-word';
import { WorkingIcon } from './working-icon';

function PreparingIcon(props: SvgIconProps): ReactElement {
  return <WorkingIcon dashed {...props} />;
}

const ICONS: Record<StepIcon, ComponentType<SvgIconProps>> = {
  working: WorkingIcon,
  preparing: PreparingIcon,
  done: CheckCircle,
  failed: ErrorOutline,
  skipped: SkipNext,
  paused: PauseCircleOutline,
  idle: RadioButtonUnchecked,
  returned: Undo,
};

/** The icon of a step's state in its tone's color. */
export function StepStateIcon({ state, size = 14 }: { state: StepState; size?: number }): ReactElement {
  const Icon = ICONS[state.icon];
  return <Icon sx={{ fontSize: size, color: toneColor(state.tone), flexShrink: 0 }} />;
}
